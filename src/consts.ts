import path from 'node:path';
import type { Config } from './config.js';

let _config: Config | null = null;

export const setConfig = (config: Config | null) => {
    _config = config;
};

export const getDownloadsDir = (): string => {
    const customLocation = _config?.download?.location?.trim();
    if (customLocation) {
        return path.resolve(customLocation);
    }
    return path.resolve(process.cwd(), 'downloads');
};

export const DOWNLOADS_DIR = (): string => getDownloadsDir();
export const getTempDir = (): string => path.resolve(getDownloadsDir(), 'temp');