import { checkbox, input, select } from '@inquirer/prompts';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readConfig, writeConfig, type Config } from './config.js';
import { DOWNLOADS_DIR, setConfig } from './consts.js';
import { FansoneApi } from './fansone.js';
import { Video } from './video.js';
import type { Post } from './fansone.d.js';
import { Photo } from './photo.js';
import dayjs from 'dayjs';

const POST_ID_REGEX = /#FD(\d+)/;

type FilterMode = 'blacklist' | 'whitelist';

type DateBoundary = {
    mode: 'before' | 'after';
    date: Date;
};

const createDateBoundary = (config: Config | null): DateBoundary | null => {
    const dateMode = config?.filter?.dateMode;
    const dateInput = config?.filter?.date?.trim();

    if (!dateMode || !dateInput) {
        return null;
    }

    try {
        const parsedDate = new Date(dateInput);
        if (isNaN(parsedDate.getTime())) {
            throw new Error('Invalid date');
        }
        return {
            mode: dateMode,
            date: parsedDate,
        };
    } catch (error) {
        console.warn(`Post filter date is invalid, will ignore date boundary (${(error as Error).message})`);
        return null;
    }
};

const shouldTerminateOnDateBoundary = (post: Post, boundary: DateBoundary): boolean => {
    const postDate = new Date(post.created_at);
    if (isNaN(postDate.getTime())) {
        return false;
    }

    if (boundary.mode === 'before') {
        return postDate > boundary.date;
    }

    return postDate < boundary.date;
};

const parseRegexInput = (input: string): RegExp => {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error('Empty regex input');
    }
    if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
        const lastSlashIndex = trimmed.lastIndexOf('/');
        const pattern = trimmed.slice(1, lastSlashIndex);
        const flags = trimmed.slice(lastSlashIndex + 1);
        return new RegExp(pattern, flags);
    }
    return new RegExp(trimmed);
};

const createPostFilter = (config: Config | null) => {
    const mode = config?.filter?.mode;
    const regexInput = config?.filter?.regex?.trim();
    const dateMode = config?.filter?.dateMode;
    const dateInput = config?.filter?.date?.trim();

    let regex: RegExp | null = null;
    if (mode && regexInput) {
        try {
            regex = parseRegexInput(regexInput);
        } catch (error) {
            console.warn(`Post filter regex is invalid, will ignore regex filter (${(error as Error).message})`);
        }
    }

    let filterDate: Date | null = null;
    if (dateMode && dateInput) {
        try {
            filterDate = new Date(dateInput);
            if (isNaN(filterDate.getTime())) {
                throw new Error('Invalid date');
            }
        } catch (error) {
            console.warn(`Post filter date is invalid, will ignore date filter (${(error as Error).message})`);
            filterDate = null;
        }
    }

    if (!regex && !filterDate) {
        return () => true;
    }

    return (post: Post) => {
        // Apply regex filter
        if (regex) {
            const haystack = [
                post.title,
                post.title_zh,
                post.title_en,
                post.content,
                post.content_zh,
                post.content_en,
                post.tags,
                post.username,
                post.displayname,
            ].filter(Boolean).join(' ');
            if (regex.global || regex.sticky) {
                regex.lastIndex = 0;
            }
            const matched = regex.test(haystack);
            const regexPassed = mode === 'blacklist' ? !matched : matched;
            if (!regexPassed) {
                return false;
            }
        }

        // Apply date filter
        if (filterDate) {
            const postDate = new Date(post.created_at);
            if (isNaN(postDate.getTime())) {
                return false;  // Skip posts with invalid dates
            }

            if (dateMode === 'before' && postDate > filterDate) {
                return false;
            }
            if (dateMode === 'after' && postDate < filterDate) {
                return false;
            }
        }

        return true;
    };
};

const collectDownloadedPostIds = async (baseDir: string): Promise<Set<number>> => {
    const downloaded = new Set<number>();
    const stack = [baseDir];
    while (stack.length > 0) {
        const currentDir = stack.pop()!;
        const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const fullPath = path.resolve(currentDir, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            const match = entry.name.match(POST_ID_REGEX);
            if (match) {
                const postId = Number(match[1]);
                if (Number.isInteger(postId)) {
                    downloaded.add(postId);
                }
            }
        }
    }
    return downloaded;
};

export async function runCli(): Promise<void> {
    let config = await readConfig();

    const fansone = new FansoneApi(config?.fansone);

    await fansone.init();

    await writeConfig({
        fansone: {
            cookies: fansone.cookiesString,
        },
    })

    const subscriptions = await fansone.getSubscriptions({
        page: 1,
        limit: 10000000,
        type: 'subscribing',
    });

    const { username } = fansone.getUserInfo();
    const downloadedPostIds = await collectDownloadedPostIds(DOWNLOADS_DIR());

    while (true) {
        const menu = await select({
            message: `User: ${username ?? '-'} | Subscriptions: ${subscriptions.count}`,
            choices: [
                { name: 'Download subscription resources', value: 'download' },
                { name: 'Settings', value: 'settings' },
                { name: 'Exit', value: 'exit' },
            ],
        });

        if (menu === 'exit') {
            break;
        }

        if (menu === 'settings') {
            const settingsMenu = await select({
                message: 'Settings',
                choices: [
                    { name: 'Download concurrency', value: 'concurrency' },
                    { name: 'Download location', value: 'location' },
                    { name: 'Post filter', value: 'filter' },
                    { name: 'Back', value: 'back' },
                ],
            });

            if (settingsMenu === 'back') {
                continue;
            }

            if (settingsMenu === 'concurrency') {
                const currentConcurrency = config?.download?.concurrency ?? 6;
                const newConcurrency = await input({
                    message: `Set download concurrency (current: ${currentConcurrency})`,
                    default: String(currentConcurrency),
                    validate: (value) => {
                        const num = Number(value);
                        if (!Number.isInteger(num) || num <= 0) {
                            return 'Please enter an integer greater than 0';
                        }
                        return true;
                    },
                });
                await writeConfig({
                    download: {
                        concurrency: Number(newConcurrency),
                    },
                });
                config = await readConfig();
                setConfig(config);
                console.log(`Concurrency updated to ${config?.download?.concurrency ?? currentConcurrency}`);
                continue;
            }

            if (settingsMenu === 'location') {
                const currentLocation = config?.download?.location ?? path.resolve(process.cwd(), 'downloads');
                const newLocation = await input({
                    message: `Set download location (current: ${currentLocation})`,
                    default: currentLocation,
                    validate: (value) => {
                        const trimmed = value.trim();
                        if (!trimmed) {
                            return 'Please enter a valid path';
                        }
                        return true;
                    },
                });
                await writeConfig({
                    download: {
                        location: newLocation.trim(),
                    },
                });
                config = await readConfig();
                setConfig(config);
                console.log(`Download location updated to ${config?.download?.location ?? currentLocation}`);
                continue;
            }

            // Filter configuration submenu
            const currentMode = config?.filter?.mode;
            const currentRegex = config?.filter?.regex ?? '';
            const currentDateMode = config?.filter?.dateMode;
            const currentDate = config?.filter?.date ?? '';

            const currentModeLabel = currentMode === 'blacklist'
                ? 'Blacklist'
                : currentMode === 'whitelist'
                    ? 'Whitelist'
                    : 'Off';
            const currentDateModeLabel = currentDateMode === 'before'
                ? 'Before'
                : currentDateMode === 'after'
                    ? 'After'
                    : 'Off';

            const filterMenu = await select({
                message: `Filter settings | Regex: ${currentModeLabel}${currentRegex ? ` (${currentRegex})` : ''} | Date: ${currentDateModeLabel}${currentDate ? ` (${currentDate})` : ''}`,
                choices: [
                    { name: 'Configure regex filter', value: 'regex' },
                    { name: 'Configure date filter', value: 'date' },
                    { name: 'Disable all filters', value: 'disabled' },
                    { name: 'Back', value: 'back' },
                ],
            });

            const updatedConfig = (await readConfig()) || {};

            if (filterMenu === 'back') {
                continue;
            }

            if (filterMenu === 'disabled') {
                if (updatedConfig.filter) {
                    delete updatedConfig.filter;
                }
                await writeConfig(updatedConfig, true);
                config = await readConfig();
                console.log('All filters disabled');
                continue;
            }

            if (filterMenu === 'regex') {
                const regexMode = await select({
                    message: `Regex filter mode (current: ${currentModeLabel})`,
                    choices: [
                        { name: 'Disable regex filter', value: 'disabled' },
                        { name: 'Blacklist', value: 'blacklist' },
                        { name: 'Whitelist', value: 'whitelist' },
                    ],
                });

                if (regexMode === 'disabled') {
                    if (updatedConfig.filter) {
                        delete updatedConfig.filter.mode;
                        delete updatedConfig.filter.regex;
                        if (Object.keys(updatedConfig.filter).length === 0) {
                            delete updatedConfig.filter;
                        }
                    }
                    await writeConfig(updatedConfig, true);
                    config = await readConfig();
                    console.log('Regex filter disabled');
                    continue;
                }

                const newRegex = await input({
                    message: `Set regex (current: ${currentRegex || 'not set'})`,
                    default: currentRegex,
                    validate: (value) => {
                        if (!value.trim()) {
                            return 'Please enter a regex or choose to disable regex filter';
                        }
                        try {
                            parseRegexInput(value);
                            return true;
                        } catch (error) {
                            return `Invalid regex: ${(error as Error).message}`;
                        }
                    },
                });

                if (!updatedConfig.filter) {
                    updatedConfig.filter = {};
                }
                updatedConfig.filter.mode = regexMode as FilterMode;
                updatedConfig.filter.regex = newRegex.trim();

                await writeConfig(updatedConfig, true);
                config = await readConfig();
                console.log(`Regex filter updated to ${regexMode}: ${newRegex.trim()}`);
                continue;
            }

            if (filterMenu === 'date') {
                const dateFilterMode = await select({
                    message: `Date filter mode (current: ${currentDateModeLabel})`,
                    choices: [
                        { name: 'Disable date filter', value: 'disabled' },
                        { name: 'Before date (posts created before specified date)', value: 'before' },
                        { name: 'After date (posts created after specified date)', value: 'after' },
                    ],
                });

                if (dateFilterMode === 'disabled') {
                    if (updatedConfig.filter) {
                        delete updatedConfig.filter.dateMode;
                        delete updatedConfig.filter.date;
                        if (Object.keys(updatedConfig.filter).length === 0) {
                            delete updatedConfig.filter;
                        }
                    }
                    await writeConfig(updatedConfig, true);
                    config = await readConfig();
                    console.log('Date filter disabled');
                    continue;
                }

                const newDate = await input({
                    message: `Set date (current: ${currentDate || 'not set'}) - Format: YYYY-MM-DD or ISO 8601`,
                    default: currentDate,
                    validate: (value) => {
                        if (!value.trim()) {
                            return 'Please enter a date or choose to disable date filter';
                        }
                        const testDate = new Date(value);
                        if (isNaN(testDate.getTime())) {
                            return 'Invalid date format';
                        }
                        return true;
                    },
                });

                if (!updatedConfig.filter) {
                    updatedConfig.filter = {};
                }
                updatedConfig.filter.dateMode = dateFilterMode as 'before' | 'after';
                updatedConfig.filter.date = newDate.trim();

                await writeConfig(updatedConfig, true);
                config = await readConfig();
                console.log(`Date filter updated to ${dateFilterMode}: ${newDate.trim()}`);
                continue;
            }
        }

        while (true) {
            const selected = await checkbox<string>({
                message: 'Select subscriptions to download (multiple selection allowed)',
                choices: [
                    ...subscriptions.data.map(item => ({
                        name: item.username,
                        value: item.trade_no,
                    })),
                    { name: 'Back to previous', value: '__back__' },
                ],
                validate: (value) => {
                    const selectedValues = value as unknown as string[];
                    if (selectedValues?.includes('__back__')) {
                        return true;
                    }
                    if (!selectedValues || selectedValues.length === 0) {
                        return 'Select at least one subscription user';
                    }
                    return true;
                },
            });

            if (selected.includes('__back__')) {
                break;
            }

            const selectedSubscriptions = subscriptions.data.filter(item => selected.includes(item.trade_no));

            console.log(`Selected ${selectedSubscriptions.length} subscription users`);

            let shouldReturnToMainMenu = false;

            while (true) {
                const selectedContentTypes = await checkbox<string>({
                    message: 'Select content types to download (multiple selection allowed)',
                    choices: [
                        { name: 'Photos', value: 'photo' },
                        { name: 'Videos', value: 'video' },
                        { name: 'Back to previous', value: '__back__' },
                    ],
                    validate: (value) => {
                        const selectedValues = value as unknown as string[];
                        if (selectedValues?.includes('__back__')) {
                            return true;
                        }
                        if (!selectedValues || selectedValues.length === 0) {
                            return 'Select at least one content type';
                        }
                        return true;
                    },
                });

                if (selectedContentTypes.includes('__back__')) {
                    break;
                }

                const shouldDownloadPhotos = selectedContentTypes.includes('photo');
                const shouldDownloadVideos = selectedContentTypes.includes('video');
                const postFilter = createPostFilter(config);
                const dateBoundary = createDateBoundary(config);
                let terminatedByDateBoundary = false;

                for (const [index, subscription] of selectedSubscriptions.entries()) {
                    console.log(`[${index + 1}/${selectedSubscriptions.length}] Downloading subscription user ${index + 1}: ${subscription.username}`);

                    if (shouldDownloadPhotos) {
                        // Get photo post list
                        let photoPosts: Post[] = [];
                        console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} Fetching first page of photo posts...`);
                        const firstPagePhotoPosts = await fansone.getPosts({
                            page: 1,
                            limit: 100,
                            type: 'picture',
                            username: subscription.username,
                        });
                        photoPosts.push(...firstPagePhotoPosts.data);
                        console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} Total photo posts: ${firstPagePhotoPosts.count}`);

                        for (let page = 2; page <= Math.ceil(firstPagePhotoPosts.count / 100); page++) {
                            console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} Fetching page ${page} of photo posts...`);
                            const currentPagePhotoPosts = await fansone.getPosts({
                                page,
                                limit: 100,
                                type: 'picture',
                                username: subscription.username,
                            });
                            photoPosts.push(...currentPagePhotoPosts.data);
                        }

                        // Keep only viewable photos
                        const canViewPhotoPosts = photoPosts.filter(post => post.can_view != 0);
                        const filteredPhotoPosts = canViewPhotoPosts.filter(postFilter);

                        const pendingPhotoPosts = filteredPhotoPosts.filter(post => !downloadedPostIds.has(post.id));
                        console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} Starting photo download - pending/filtered/viewable/total: ${pendingPhotoPosts.length}/${filteredPhotoPosts.length}/${canViewPhotoPosts.length}/${photoPosts.length}`);

                        for (const [photoIndex, photoPost] of pendingPhotoPosts.entries()) {
                            if (dateBoundary && shouldTerminateOnDateBoundary(photoPost, dateBoundary)) {
                                console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} Reached date boundary at post #FD${photoPost.id}, terminating current download task`);
                                terminatedByDateBoundary = true;
                                break;
                            }

                            const fileName = `${dayjs(photoPost.created_at).format('YYYYMMDD-HHmmss')}_${photoPost.id}_${photoPost.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'photo'}`;
                            console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} (${photoIndex + 1}/${pendingPhotoPosts.length}) Downloading photo post: ${fileName}`);

                            try {
                                const photo = new Photo({
                                    post: photoPost,
                                });
                                await photo.downloadToLocal();
                                downloadedPostIds.add(photoPost.id);
                            } catch (error) {
                                console.error(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} (${photoIndex + 1}/${pendingPhotoPosts.length}) Failed to download photo post: ${fileName}`, error);
                            }
                        }

                        if (terminatedByDateBoundary) {
                            break;
                        }
                    }

                    if (shouldDownloadVideos) {
                        // Get video post list
                        let videoPosts: Post[] = [];

                        console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} Fetching first page of video posts...`);
                        const firstPageVideoPosts = await fansone.getPosts({
                            page: 1,
                            limit: 100,
                            type: 'video',
                            username: subscription.username,
                        });
                        videoPosts.push(...firstPageVideoPosts.data);

                        console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} Total video posts: ${firstPageVideoPosts.count}`);

                        for (let page = 2; page <= Math.ceil(firstPageVideoPosts.count / 100); page++) {
                            console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} Fetching page ${page} of video posts...`);
                            const currentPageVideoPosts = await fansone.getPosts({
                                page,
                                limit: 100,
                                type: 'video',
                                username: subscription.username,
                            });
                            videoPosts.push(...currentPageVideoPosts.data);
                        }

                        // Keep only viewable videos
                        const canViewVideoPosts = videoPosts.filter(post => post.can_view != 0);
                        const filteredVideoPosts = canViewVideoPosts.filter(postFilter);

                        const pendingPosts = filteredVideoPosts.filter(post => !downloadedPostIds.has(post.id));
                        console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} Starting video download - pending/filtered/viewable/total: ${pendingPosts.length}/${filteredVideoPosts.length}/${canViewVideoPosts.length}/${videoPosts.length}`);

                        for (const [videoIndex, videoPost] of pendingPosts.entries()) {
                            if (dateBoundary && shouldTerminateOnDateBoundary(videoPost, dateBoundary)) {
                                console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} Reached date boundary at post #FD${videoPost.id}, terminating current download task`);
                                terminatedByDateBoundary = true;
                                break;
                            }

                            const fileName = `${dayjs(videoPost.created_at).format('YYYYMMDD-HHmmss')}_${videoPost.id}_${videoPost.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video'}`;
                            console.log(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} (${videoIndex + 1}/${pendingPosts.length}) Downloading video post: ${fileName}`);

                            try {
                                const video = new Video({
                                    post: videoPost,
                                    fansone,
                                });
                                await video.downloadToLocal();
                                downloadedPostIds.add(videoPost.id);
                            } catch (error) {
                                console.error(`[${index + 1}/${selectedSubscriptions.length}] ${subscription.username} (${videoIndex + 1}/${pendingPosts.length}) Failed to download video post: ${fileName}`, error);
                            }

                        }

                        if (terminatedByDateBoundary) {
                            break;
                        }
                    }

                    if (terminatedByDateBoundary) {
                        break;
                    }
                }

                if (terminatedByDateBoundary) {
                    console.log('Date boundary reached, returning to main menu');
                }

                shouldReturnToMainMenu = true;
                break;
            }

            if (shouldReturnToMainMenu) {
                break;
            }
        }
    }
}
