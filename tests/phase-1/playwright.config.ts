import {fileURLToPath} from 'node:url';
import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'browser.spec.ts',workers:1,reporter:'list',outputDir:'../../.local-browser-results',use:{baseURL:'http://127.0.0.1:5173',headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}},webServer:[
 {command:'npm run dev',cwd:fileURLToPath(new URL('../../',import.meta.url)),url:'http://127.0.0.1:8888/api/health',reuseExistingServer:false,timeout:30000},
 {command:'npm run dev:web',cwd:fileURLToPath(new URL('../../',import.meta.url)),url:'http://127.0.0.1:5173',reuseExistingServer:false,timeout:30000}
]});
