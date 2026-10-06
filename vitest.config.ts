import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 60000,
    // 集成测试会真的拉起 Chromium：并行跑多个文件时机器上会同时出现十几个
    // Chrome 进程，偶发启动失败（内核进程 code=21）。串行跑换掉这个抖动，
    // 单元文件本身很快，整体耗时差别不大。
    fileParallelism: false
  }
})
