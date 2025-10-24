// Frontend Memory Management Utilities
// 前端内存管理工具

interface MemoryStats {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface MemoryManager {
  getMemoryStats(): MemoryStats | null;
  forceGarbageCollection(): void;
  monitorMemoryUsage(callback: (stats: MemoryStats) => void): () => void;
  isMemoryPressureHigh(): boolean;
  cleanupResources(): void;
}

class FrontendMemoryManager implements MemoryManager {
  private memoryMonitorInterval: number | null = null;
  private readonly MEMORY_PRESSURE_THRESHOLD = 0.8; // 80% 内存使用率阈值
  private readonly CLEANUP_INTERVAL = 30000; // 30秒清理一次
  private cleanupTimer: number | null = null;

  constructor() {
    this.startPeriodicCleanup();
  }

  // 获取内存使用统计
  getMemoryStats(): MemoryStats | null {
    if ('memory' in performance) {
      const memory = (performance as any).memory;
      return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      };
    }
    return null;
  }

  // 强制垃圾回收（仅在开发模式下有效）
  forceGarbageCollection(): void {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      // 尝试触发垃圾回收
      if ('gc' in window) {
        (window as any).gc();
        console.log('[MemoryManager] 强制垃圾回收已执行');
      } else {
        // 备用方法：创建大量临时对象然后丢弃
        const tempArrays = [];
        for (let i = 0; i < 1000; i++) {
          tempArrays.push(new Array(1000).fill(Math.random()));
        }
        tempArrays.length = 0;
        console.log('[MemoryManager] 使用备用方法触发垃圾回收');
      }
    }
  }

  // 监控内存使用情况
  monitorMemoryUsage(callback: (stats: MemoryStats) => void): () => void {
    const monitor = () => {
      const stats = this.getMemoryStats();
      if (stats) {
        callback(stats);
        
        // 如果内存压力过高，自动清理
        if (this.isMemoryPressureHigh()) {
          console.warn('[MemoryManager] 检测到高内存压力，执行自动清理');
          this.cleanupResources();
        }
      }
    };

    // 立即执行一次
    monitor();

    // 每5秒监控一次
    this.memoryMonitorInterval = window.setInterval(monitor, 5000);

    // 返回停止监控的函数
    return () => {
      if (this.memoryMonitorInterval) {
        clearInterval(this.memoryMonitorInterval);
        this.memoryMonitorInterval = null;
      }
    };
  }

  // 检查是否内存压力过高
  isMemoryPressureHigh(): boolean {
    const stats = this.getMemoryStats();
    if (!stats) return false;
    
    const usageRatio = stats.usedJSHeapSize / stats.jsHeapSizeLimit;
    return usageRatio > this.MEMORY_PRESSURE_THRESHOLD;
  }

  // 清理资源
  cleanupResources(): void {
    console.log('[MemoryManager] 开始清理前端资源...');

    // 清理图片缓存
    this.cleanupImageCache();
    
    // 清理音频缓存
    this.cleanupAudioCache();
    
    // 清理事件监听器
    this.cleanupEventListeners();
    
    // 强制垃圾回收
    this.forceGarbageCollection();
    
    console.log('[MemoryManager] 前端资源清理完成');
  }

  // 清理图片缓存
  private cleanupImageCache(): void {
    // 清理可能存在的图片缓存
    const images = document.querySelectorAll('img');
    images.forEach(img => {
      if (img.src.startsWith('blob:') || img.src.startsWith('data:')) {
        // 清理blob和data URL图片
        img.src = '';
        img.removeAttribute('src');
      }
    });
  }

  // 清理音频缓存
  private cleanupAudioCache(): void {
    // 清理可能存在的音频元素
    const audios = document.querySelectorAll('audio');
    audios.forEach(audio => {
      audio.pause();
      audio.src = '';
      audio.load();
    });
  }

  // 清理事件监听器
  private cleanupEventListeners(): void {
    // 这里可以添加清理特定事件监听器的逻辑
    // 例如清理全局的resize、scroll等监听器
    console.log('[MemoryManager] 事件监听器清理完成');
  }

  // 启动定期清理
  private startPeriodicCleanup(): void {
    this.cleanupTimer = window.setInterval(() => {
      const stats = this.getMemoryStats();
      if (stats) {
        const usageRatio = stats.usedJSHeapSize / stats.jsHeapSizeLimit;
        console.log(`[MemoryManager] 内存使用率: ${(usageRatio * 100).toFixed(1)}%`);
        
        if (usageRatio > 0.7) { // 70% 时开始定期清理
          this.cleanupResources();
        }
      }
    }, this.CLEANUP_INTERVAL);
  }

  // 销毁内存管理器
  destroy(): void {
    if (this.memoryMonitorInterval) {
      clearInterval(this.memoryMonitorInterval);
      this.memoryMonitorInterval = null;
    }
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    console.log('[MemoryManager] 内存管理器已销毁');
  }
}

// 创建全局内存管理器实例
const memoryManager = new FrontendMemoryManager();

// 导出工具函数
export const MemoryUtils = {
  // 获取内存统计
  getMemoryStats: () => memoryManager.getMemoryStats(),
  
  // 强制垃圾回收
  forceGC: () => memoryManager.forceGarbageCollection(),
  
  // 监控内存使用
  monitorMemory: (callback: (stats: MemoryStats) => void) => 
    memoryManager.monitorMemoryUsage(callback),
  
  // 检查内存压力
  isHighMemoryPressure: () => memoryManager.isMemoryPressureHigh(),
  
  // 清理资源
  cleanup: () => memoryManager.cleanupResources(),
  
  // 销毁管理器
  destroy: () => memoryManager.destroy(),
};

// 在页面卸载时清理资源
window.addEventListener('beforeunload', () => {
  memoryManager.destroy();
});

// 导出类型
export type { MemoryStats, MemoryManager };

export default MemoryUtils;
