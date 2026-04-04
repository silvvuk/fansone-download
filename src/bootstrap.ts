import { initConfig, readConfig } from "./config.js";
import { initData } from "./data.js";
import { dirExistsOrMkdir } from "./utils.js";
import { getTempDir, setConfig } from "./consts.js";

export const bootstrap = async () => {
    await initConfig();
    const config = await readConfig();
    setConfig(config);
    await dirExistsOrMkdir(getTempDir());
    await initData();
}