import type { Post } from "./fansone.d.js";
import { FansoneApi } from "./fansone.js";
import { DOWNLOADS_DIR, getTempDir } from "./consts.js";
import { dirExistsOrMkdir, getSpeedText, userDirName } from "./utils.js";
import path from 'node:path';
import { createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import PQueue from 'p-queue';
import got from 'got';
import dayjs from 'dayjs';
import cliProgress from 'cli-progress';
import { Demuxer, Muxer } from 'node-av/api';
import {
    AVMEDIA_TYPE_AUDIO,
    AVMEDIA_TYPE_VIDEO,
    AV_CODEC_ID_H264,
    AV_CODEC_ID_HEVC,
    AV_CODEC_ID_AV1,
    AV_CODEC_ID_AAC,
    AV_CODEC_ID_AAC_LATM,
    AV_CODEC_ID_MP3,
} from 'node-av/constants';
import { readData, writeData } from './data.js';
import { logger } from './logger.js';
import { readConfig } from "./config.js";

export class Video {
    private post: Post;
    private fansone: FansoneApi;

    constructor({
        post,
        fansone,
    }: {
        post: Post;
        fansone: FansoneApi;
    }) {
        this.post = post;
        this.fansone = fansone;
    }

    private async getM3u8Url() {

        switch (this.post.domain) {
            case 'video9194.fansone.co':
                return await this.fansone.getVideoSignedUrl({
                    videoId: this.post.video,
                    domain: this.post.domain,
                });
            default:
                // video5, video7, and other Bunny CDN domains serve the playlist at
                // https://{domain}/{domain}/{videoId}/video_1.m3u8
                // The /bunny/signed-url endpoint only accepts the video9194 domain.
                return `https://${this.post.domain}/${this.post.domain}/${this.post.video}/video_1.m3u8`;
        }


    }

    public async downloadToLocal() {

        const outputDir = path.resolve(DOWNLOADS_DIR(), userDirName(this.post), 'videos');
        await dirExistsOrMkdir(outputDir);
        const fileName = `${dayjs(this.post.created_at).format('YYYYMMDD-HHmmss')}_${this.post.id}_${this.post.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video'}`;

        // Early out if output file already exists
        const existingOutputs = await fs.readdir(outputDir).catch(() => []);
        const outputExists = existingOutputs.some(file => file.startsWith(fileName));

        if (outputExists) {
            logger.info(`[Video] Output file already exists, skipping download`);
            return;
        }

        const m3u8Url = await this.getM3u8Url();
        const tsRangeTempDir = path.resolve(getTempDir(), `ts-range-${this.post.id}`);

        await dirExistsOrMkdir(tsRangeTempDir);
        logger.info(`[Video] Start downloading m3u8: ${m3u8Url}`);
        const requestHeaders = {
            referer: 'https://fansone.co/',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0'
        };

        const maxRetries = 3;
        const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        const fetchTextWithRetry = async (url: string) => {
            for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
                try {
                    return (await got.get(url, {
                        headers: requestHeaders,
                        retry: {
                            limit: 0,
                        },
                    })).body;
                } catch (error) {
                    if (attempt >= maxRetries) {
                        throw error;
                    }
                    const wait = 500 * (2 ** (attempt - 1));
                    logger.warn(`[Video:${this.post.id}] Request failed, retrying after ${wait}ms (${attempt}/${maxRetries})`);
                    await sleep(wait);
                }
            }
            return '';
        };

        const resolveUrl = (baseUrl: string, target: string) => new URL(target, baseUrl).toString();
        const parseM3u8 = (content: string, baseUrl: string) => {
            const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            const segments: string[] = [];
            let nestedPlaylistUrl: string | undefined;
            let initUrl: string | undefined;
            let audioPlaylistUrl: string | undefined;
            let audioIsDefault = false;
            let bestBandwidth = -1;

            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i];
                if (line.startsWith('#EXT-X-MAP')) {
                    const uri = /URI="([^"]+)"/.exec(line)?.[1];
                    if (uri) {
                        initUrl = resolveUrl(baseUrl, uri);
                    }
                    continue;
                }
                // Separate audio rendition: the video variant carries no audio track itself
                if (line.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(line)) {
                    const uri = /URI="([^"]+)"/.exec(line)?.[1];
                    if (uri) {
                        const isDefault = /DEFAULT=YES/i.test(line);
                        if (!audioPlaylistUrl || (isDefault && !audioIsDefault)) {
                            audioPlaylistUrl = resolveUrl(baseUrl, uri);
                            audioIsDefault = isDefault;
                        }
                    }
                    continue;
                }
                if (line.startsWith('#EXT-X-STREAM-INF')) {
                    const nextLine = lines[i + 1];
                    if (nextLine && !nextLine.startsWith('#')) {
                        const bandwidth = Number(/(?:^|[:,])BANDWIDTH=(\d+)/i.exec(line)?.[1] ?? 0);
                        if (bandwidth > bestBandwidth) {
                            bestBandwidth = bandwidth;
                            nestedPlaylistUrl = resolveUrl(baseUrl, nextLine);
                        }
                        i += 1;
                    }
                    continue;
                }
                if (line.startsWith('#')) {
                    continue;
                }
                if (line.endsWith('.m3u8') && segments.length === 0 && !nestedPlaylistUrl) {
                    nestedPlaylistUrl = resolveUrl(baseUrl, line);
                    continue;
                }
                segments.push(resolveUrl(baseUrl, line));
            }

            return { segments, nestedPlaylistUrl, initUrl, audioPlaylistUrl };
        };

        let m3u8Text = await fetchTextWithRetry(m3u8Url);
        let { segments, nestedPlaylistUrl, initUrl, audioPlaylistUrl } = parseM3u8(m3u8Text, m3u8Url);

        if (segments.length === 0 && nestedPlaylistUrl) {
            logger.debug(`[Video:${this.post.id}] Using sub-playlist: ${nestedPlaylistUrl}`);
            m3u8Text = await fetchTextWithRetry(nestedPlaylistUrl);
            ({ segments, initUrl } = parseM3u8(m3u8Text, nestedPlaylistUrl));
        }

        // fMP4 (CMAF) playlists need the EXT-X-MAP init segment; without it ffmpeg can't read the moov info
        const fetchInit = async (url: string | undefined, targetPath: string) => {
            if (!url) {
                return;
            }
            const hasInit = await fs.stat(targetPath).then(stat => stat.size > 0).catch(() => false);
            if (!hasInit) {
                const initData = await got.get(url, {
                    headers: requestHeaders,
                    responseType: 'buffer',
                    retry: { limit: maxRetries },
                }).buffer();
                await fs.writeFile(targetPath, initData);
            }
        };
        await fetchInit(initUrl, path.resolve(tsRangeTempDir, 'init.mp4'));

        // Separate audio rendition is downloaded into its own subdirectory and muxed with the video
        const audioDir = path.resolve(tsRangeTempDir, 'audio');
        let audioInitUrl: string | undefined;
        let audioSegments: string[] = [];
        if (audioPlaylistUrl) {
            logger.info(`[Video:${this.post.id}] Using audio playlist: ${audioPlaylistUrl}`);
            await dirExistsOrMkdir(audioDir);
            const audioText = await fetchTextWithRetry(audioPlaylistUrl);
            ({ segments: audioSegments, initUrl: audioInitUrl } = parseM3u8(audioText, audioPlaylistUrl));
            await fetchInit(audioInitUrl, path.resolve(audioDir, 'init.mp4'));
        }

        const videoSegmentCount = segments.length;
        segments = [...segments, ...audioSegments];
        const segmentLocation = (index: number) => index < videoSegmentCount
            ? { dir: tsRangeTempDir, local: index, fmp4: Boolean(initUrl) }
            : { dir: audioDir, local: index - videoSegmentCount, fmp4: Boolean(audioInitUrl) };

        logger.info(`[Video:${this.post.id}] Number of segments: ${videoSegmentCount} video + ${audioSegments.length} audio`);

        const data = await readData();
        const videoKey = String(this.post.id);
        const now = new Date().toISOString();
        const existingProgress = data.videos[videoKey];
        const completedSet = new Set<number>(existingProgress?.completedSegments ?? []);

        // Truncated segments from interrupted runs cause "partial file"/corrupt packet errors when muxing
        const isSegmentComplete = async (filePath: string, fmp4: boolean): Promise<boolean> => {
            const handle = await fs.open(filePath, 'r').catch(() => null);
            if (!handle) {
                return false;
            }
            try {
                const { size } = await handle.stat();
                if (size === 0) {
                    return false;
                }
                if (!fmp4) {
                    return size % 188 === 0;
                }
                // fMP4: top-level box sizes must add up exactly to the file size
                const header = Buffer.alloc(16);
                let offset = 0;
                while (offset < size) {
                    if (size - offset < 8) {
                        return false;
                    }
                    await handle.read(header, 0, 16, offset);
                    let boxSize = header.readUInt32BE(0);
                    if (boxSize === 1) {
                        boxSize = Number(header.readBigUInt64BE(8));
                    } else if (boxSize === 0) {
                        boxSize = size - offset;
                    }
                    if (boxSize < 8) {
                        return false;
                    }
                    offset += boxSize;
                }
                return offset === size;
            } finally {
                await handle.close();
            }
        };

        const existingSet = new Set<number>();
        for (const [dir, offset, fmp4] of [
            [tsRangeTempDir, 0, Boolean(initUrl)],
            [audioDir, videoSegmentCount, Boolean(audioInitUrl)],
        ] as const) {
            const existingFiles = await fs.readdir(dir).catch(() => []);
            for (const file of existingFiles) {
                if (file.toLowerCase().endsWith('.part')) {
                    await fs.rm(path.resolve(dir, file), { force: true });
                    continue;
                }
                if (!file.toLowerCase().endsWith('.ts')) {
                    continue;
                }
                const localIndex = Number.parseInt(file.replace('.ts', ''), 10);
                if (!Number.isInteger(localIndex)) {
                    continue;
                }
                const index = localIndex + offset;
                const segPath = path.resolve(dir, file);
                if (!(await isSegmentComplete(segPath, fmp4))) {
                    logger.warn(`[Video:${this.post.id}] Removing incomplete segment: ${file}`);
                    await fs.rm(segPath, { force: true });
                    completedSet.delete(index);
                    continue;
                }
                existingSet.add(index);
                completedSet.add(index);
            }
        }

        const persistProgress = (() => {
            let dirtyCount = 0;
            let saveChain = Promise.resolve();
            return async (force = false) => {
                dirtyCount += 1;
                if (!force && dirtyCount < 10) {
                    return;
                }
                dirtyCount = 0;
                data.videos[videoKey] = {
                    totalSegments: segments.length,
                    completedSegments: Array.from(completedSet).sort((a, b) => a - b),
                    status: 'downloading',
                    createdAt: existingProgress?.createdAt ?? now,
                    updatedAt: new Date().toISOString(),
                    title: this.post.title,
                    username: this.post.username,
                };
                saveChain = saveChain.then(() => writeData(data));
                await saveChain;
            };
        })();

        await persistProgress(true);

        const totalSegments = segments.length;
        const initialSkipped = existingSet.size;

        // If temporary file directory exists and segment count matches segments.length, skip ts download and go directly to muxing
        if (initialSkipped === totalSegments && totalSegments > 0) {
            logger.info(`[Video:${this.post.id}] All temporary segments present, skipping ts download`);
        } else {
            const concurrency = (await readConfig()).download?.concurrency ?? 6;
            const queue = new PQueue({ concurrency });
            let completed = 0;
            let skipped = initialSkipped;
            let bytesDownloaded = 0;
            const startedAt = Date.now();

            const progressBar = new cliProgress.SingleBar({
                format: `[Video:${this.post.id}] {bar} {percentage}% | {value}/{total} | {speed} | Skipped:{skipped}`,
                hideCursor: true,
                clearOnComplete: true,
            }, cliProgress.Presets.shades_classic);

            progressBar.start(totalSegments, skipped, {
                speed: getSpeedText(startedAt, bytesDownloaded),
                skipped,
            });

            const updateProgress = () => {
                progressBar.update(completed + skipped, {
                    speed: getSpeedText(startedAt, bytesDownloaded),
                    skipped,
                });
            };

            const downloadSegment = async (segmentUrl: string, filePath: string) => {
                for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
                    try {
                        const stream = got.stream(segmentUrl, {
                            headers: requestHeaders,
                            retry: {
                                limit: 0,
                            },
                        });
                        let segmentBytes = 0;
                        stream.on('data', (chunk: Buffer) => {
                            segmentBytes += chunk.length;
                        });
                        const partPath = `${filePath}.part`;
                        try {
                            await pipeline(stream, createWriteStream(partPath));
                            await fs.rename(partPath, filePath);
                        } catch (error) {
                            await fs.rm(partPath, { force: true });
                            throw error;
                        }
                        return segmentBytes;
                    } catch (error) {
                        if (attempt >= maxRetries) {
                            throw error;
                        }
                        const wait = 500 * (2 ** (attempt - 1));
                        logger.warn(`[Video:${this.post.id}] Segment download failed, retrying after ${wait}ms (${attempt}/${maxRetries})`);
                        await sleep(wait);
                    }
                }
                return 0;
            };

            const tasks = segments.map((segmentUrl, index) => queue.add(async () => {
                const { dir, local } = segmentLocation(index);
                const segFileName = `${String(local).padStart(6, '0')}.ts`;
                const filePath = path.resolve(dir, segFileName);
                const exists = await fs.stat(filePath).then(stat => stat.size > 0).catch(() => false);
                if (exists) {
                    if (!completedSet.has(index)) {
                        completedSet.add(index);
                        skipped += 1;
                        await persistProgress();
                        updateProgress();
                    }
                    return;
                }
                const segmentBytes = await downloadSegment(segmentUrl, filePath);
                completed += 1;
                bytesDownloaded += segmentBytes;
                completedSet.add(index);
                await persistProgress();
                updateProgress();
            }));

            await Promise.all(tasks);
            progressBar.stop();
            logger.info(`[Video:${this.post.id}] Download completed, skipped: ${skipped}, success: ${completed}`);
        }
        await this.remuxWithNodeAv(tsRangeTempDir, audioPlaylistUrl ? audioDir : null, outputDir, fileName);

        // Remove the completed entry to keep data.json small.
        // Completed downloads are detected by the existence of the output file on disk
        // (see the early-out check at the top of this method), so persisting completed
        // entries here serves no functional purpose.
        delete data.videos[videoKey];
        await writeData(data);

        await fs.rm(tsRangeTempDir, { recursive: true });
        logger.debug(`[Video:${this.post.id}] Deleted temporary directory: ${tsRangeTempDir}`);
    }

    private async remuxWithNodeAv(tsDir: string, audioDir: string | null, outputDir: string, fileName: string): Promise<string | null> {
        const tsFiles = (await fs.readdir(tsDir))
            .filter(file => file.toLowerCase().endsWith('.ts'))
            .sort();

        if (tsFiles.length === 0) {
            logger.warn(`[Video:${this.post.id}] No ts segments found, skipping muxing`);
            return null;
        }
        const openSegment = async (dir: string, initData: Buffer | null, file: string, tmpName = 'combined.tmp.mp4') => {
            const segPath = path.resolve(dir, file);
            if (!initData) {
                return Demuxer.open(segPath);
            }
            const combinedPath = path.resolve(dir, tmpName);
            await fs.writeFile(combinedPath, Buffer.concat([initData, await fs.readFile(segPath)]));
            return Demuxer.open(combinedPath);
        };
        const initData = await fs.readFile(path.resolve(tsDir, 'init.mp4')).catch(() => null);
        const probe = await openSegment(tsDir, initData, tsFiles[0], 'probe.tmp.mp4');

        let audioFiles: string[] = [];
        let audioInitData: Buffer | null = null;
        let audioProbe: Awaited<ReturnType<typeof Demuxer.open>> | null = null;
        if (audioDir) {
            audioFiles = (await fs.readdir(audioDir).catch(() => []))
                .filter(file => file.toLowerCase().endsWith('.ts'))
                .sort();
            if (audioFiles.length > 0) {
                audioInitData = await fs.readFile(path.resolve(audioDir, 'init.mp4')).catch(() => null);
                audioProbe = await openSegment(audioDir, audioInitData, audioFiles[0], 'probe.tmp.mp4');
            }
        }

        let outputPath: string | null = null;

        try {
            const streams = probe.streams ?? [];
            const videoStream = typeof probe.video === 'function' ? probe.video() : null;
            const videoAudioStream = typeof probe.audio === 'function' ? probe.audio() : null;
            const separateAudioStream = audioProbe && typeof audioProbe.audio === 'function' ? audioProbe.audio() : null;
            const audioStream = separateAudioStream ?? videoAudioStream;

            if (!audioStream) {
                logger.warn(`[Video:${this.post.id}] No audio stream found; output will be silent`);
            }

            const getCodecId = (stream: any) =>
                stream?.codecpar?.codecId
                ?? stream?.codecpar?.codec_id
                ?? null;
            const getCodecName = (stream: any, fallback?: string) =>
                stream?.codecpar?.codecName
                ?? stream?.codecpar?.codec_name
                ?? fallback
                ?? 'unknown';

            const videoCodecId = videoStream ? getCodecId(videoStream) : null;
            const audioCodecId = audioStream ? getCodecId(audioStream) : null;
            const videoCodecName = videoStream ? String(getCodecName(videoStream, String(videoCodecId ?? 'none'))) : 'none';
            const audioCodecName = audioStream ? String(getCodecName(audioStream, String(audioCodecId ?? 'none'))) : 'none';

            const isMp4FriendlyVideo = videoCodecId === AV_CODEC_ID_H264
                || videoCodecId === AV_CODEC_ID_HEVC
                || videoCodecId === AV_CODEC_ID_AV1;
            const isMp4FriendlyAudio = audioCodecId === null
                || audioCodecId === AV_CODEC_ID_AAC
                || audioCodecId === AV_CODEC_ID_AAC_LATM
                || audioCodecId === AV_CODEC_ID_MP3;
            const outputFormat = isMp4FriendlyVideo && isMp4FriendlyAudio ? 'mp4' : 'matroska';
            const outputExt = outputFormat === 'mp4' ? 'mp4' : 'mkv';

            await dirExistsOrMkdir(outputDir);
            outputPath = path.resolve(outputDir, `${fileName}.${outputExt}`);

            logger.info(`[Video:${this.post.id}] Inferred format: video=${videoCodecName}(${videoCodecId ?? 'none'}), audio=${audioCodecName}(${audioCodecId ?? 'none'})`);
            logger.info(`[Video:${this.post.id}] Muxing output: ${outputPath}`);

            const muxer = await Muxer.open(outputPath, {
                input: probe,
                format: outputFormat,
                options: outputFormat === 'mp4' ? { movflags: 'faststart' } : undefined,
            });

            try {
                const streamIndexMap = new Map<number, number>();
                const resetCodecTagForMp4 = (stream: any) => {
                    if (outputFormat !== 'mp4' || !stream?.codecpar) {
                        return;
                    }
                    if (typeof stream.codecpar.codecTag === 'number') {
                        stream.codecpar.codecTag = 0;
                    }
                    if (typeof stream.codecpar.codec_tag === 'number') {
                        stream.codecpar.codec_tag = 0;
                    }
                };
                if (videoStream) {
                    resetCodecTagForMp4(videoStream);
                    const outIndex = muxer.addStream(videoStream);
                    streamIndexMap.set(videoStream.index, outIndex);
                }
                const audioIndexMap = new Map<number, number>();
                if (audioStream) {
                    resetCodecTagForMp4(audioStream);
                    const outIndex = muxer.addStream(audioStream);
                    (separateAudioStream ? audioIndexMap : streamIndexMap).set(audioStream.index, outIndex);
                }
                for (const stream of streams) {
                    if (!streamIndexMap.has(stream.index) && stream?.codecpar?.codecType !== AVMEDIA_TYPE_VIDEO && stream?.codecpar?.codecType !== AVMEDIA_TYPE_AUDIO) {
                        resetCodecTagForMp4(stream);
                        const outIndex = muxer.addStream(stream);
                        streamIndexMap.set(stream.index, outIndex);
                    }
                }

                const writeSegment = async (seg: Awaited<ReturnType<typeof Demuxer.open>>, indexMap: Map<number, number>) => {
                    try {
                        for await (const packet of seg.packets()) {
                            if (!packet) {
                                continue;
                            }
                            const targetIndex = indexMap.get(packet.streamIndex);
                            if (targetIndex !== undefined) {
                                await muxer.writePacket(packet, targetIndex);
                            }
                            if (typeof packet.free === 'function') {
                                packet.free();
                            }
                        }
                    } finally {
                        await seg.close();
                    }
                };

                // Interleave video and audio segment by segment so players can stream the result
                const segmentCount = Math.max(tsFiles.length, audioFiles.length);
                for (let i = 0; i < segmentCount; i += 1) {
                    if (i < tsFiles.length) {
                        await writeSegment(await openSegment(tsDir, initData, tsFiles[i]), streamIndexMap);
                    }
                    if (audioDir && i < audioFiles.length && separateAudioStream) {
                        await writeSegment(await openSegment(audioDir, audioInitData, audioFiles[i], 'audio-combined.tmp.mp4'), audioIndexMap);
                    }
                }
            } finally {
                await muxer.close();
            }
        } finally {
            await probe.close();
            await audioProbe?.close();
        }

        logger.info(`[Video:${this.post.id}] Muxing completed`);
        return outputPath;
    }

}