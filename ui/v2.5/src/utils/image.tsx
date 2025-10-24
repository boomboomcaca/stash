import React, { useCallback, useEffect } from "react";

const readImage = (file: File, onLoadEnd: (imageData: string) => void) => {
  const reader: FileReader = new FileReader();
  
  // ✅ 添加错误处理和资源清理
  const cleanup = () => {
    reader.onloadend = null;
    reader.onerror = null;
    reader.onabort = null;
  };
  
  reader.onloadend = () => {
    // only proceed if no error encountered
    if (!reader.error) {
      onLoadEnd(reader.result as string);
    }
    cleanup(); // ✅ 清理事件监听器
  };
  
  reader.onerror = () => {
    cleanup(); // ✅ 错误时也要清理
  };
  
  reader.onabort = () => {
    console.warn('FileReader aborted');
    cleanup(); // ✅ 中止时也要清理
  };
  
  reader.readAsDataURL(file);
};

const pasteImage = (
  event: ClipboardEvent,
  onLoadEnd: (imageData: string) => void
) => {
  const files = event?.clipboardData?.files;
  if (!files?.length) return;

  const file = files[0];
  readImage(file, onLoadEnd);
};

const onImageChange = (
  event: React.FormEvent<HTMLInputElement>,
  onLoadEnd: (imageData: string) => void
) => {
  const file = event?.currentTarget?.files?.[0];
  if (file) readImage(file, onLoadEnd);
};

const usePasteImage = (
  onLoadEnd: (imageData: string) => void,
  isActive: boolean = true
) => {
  const encodeImage = useCallback(
    (data: string) => {
      onLoadEnd(data);
    },
    [onLoadEnd]
  );

  useEffect(() => {
    const paste = (event: ClipboardEvent) => pasteImage(event, encodeImage);
    if (isActive) {
      document.addEventListener("paste", paste);
    }

    return () => document.removeEventListener("paste", paste);
  }, [isActive, encodeImage]);

  return false;
};

const imageToDataURL = async (url: string) => {
  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    
    // ✅ 添加超时处理和资源清理
    const timeoutId = setTimeout(() => {
      reader.abort();
      reject(new Error('FileReader timeout'));
    }, 30000); // 30秒超时
    
    const cleanup = () => {
      clearTimeout(timeoutId);
      reader.onloadend = null;
      reader.onerror = null;
      reader.onabort = null;
    };
    
    reader.onloadend = () => {
      cleanup();
      resolve(reader.result as string);
    };
    
    reader.onerror = () => {
      cleanup();
      reject(reader.error || new Error('FileReader error'));
    };
    
    reader.onabort = () => {
      cleanup();
      reject(new Error('FileReader aborted'));
    };
    
    reader.readAsDataURL(blob);
  });
};

const ImageUtils = {
  onImageChange,
  usePasteImage,
  imageToDataURL,
};

export default ImageUtils;
