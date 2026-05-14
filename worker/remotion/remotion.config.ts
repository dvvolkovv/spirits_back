// worker/remotion/remotion.config.ts
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setPixelFormat('yuv420p');
Config.setCodec('h264');
Config.setConcurrency(1);
Config.setChromiumOpenGlRenderer('angle');
