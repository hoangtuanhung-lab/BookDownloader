import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({root:'apps/web',envDir:'../..',plugins:[react()],server:{host:'127.0.0.1',proxy:{'/api':'http://127.0.0.1:8888'}},build:{outDir:'dist',sourcemap:false}});
