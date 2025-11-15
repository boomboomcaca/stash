/**
 * 开发/生产环境日志工具
 * 在生产环境中自动禁用非错误日志
 */

const isDevelopment = import.meta.env.MODE === 'development';

export const logger = {
  log: isDevelopment ? console.log.bind(console) : () => {},
  warn: isDevelopment ? console.warn.bind(console) : () => {},
  error: console.error.bind(console), // 错误始终记录
  debug: isDevelopment ? console.debug.bind(console) : () => {},
};

// 性能监控（仅开发环境）
export const perfLogger = {
  start: (label: string) => {
    if (isDevelopment) {
      console.time(label);
    }
  },
  end: (label: string) => {
    if (isDevelopment) {
      console.timeEnd(label);
    }
  },
};
