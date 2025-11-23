import { useState, useRef, useCallback } from 'react';
import { useModelStatus } from './useModelStatus';

/**
 * 分段实时转录 Hook
 * 每隔固定时间（默认2.5秒）处理一次音频段，实现准实时转录
 */
export const useChunkedRecording = () => {
  const [partialResults, setPartialResults] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [allText, setAllText] = useState('');

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioChunksRef = useRef([]);
  const chunkTimerRef = useRef(null);
  const chunkCounterRef = useRef(0);
  const processingRef = useRef(false);
  const lastProcessTimeRef = useRef(0);

  // 使用模型状态Hook
  const modelStatus = useModelStatus();

  // 配置参数
  const CHUNK_INTERVAL = 2500; // 每2.5秒处理一次
  const MIN_AUDIO_DURATION = 0.8; // 最小0.8秒音频
  const MIN_CHUNK_SIZE = 1000; // 最小块大小（字节）

  /**
   * 转换音频格式为WAV
   */
  const convertToWav = useCallback(async (audioBlob) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result;

          // 创建AudioContext
          const audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000
          });

          // 解码音频数据
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

          // 转换为WAV格式
          const wavBuffer = audioBufferToWav(audioBuffer);
          const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });

          // 关闭AudioContext释放资源
          audioContext.close();

          resolve(wavBlob);
        } catch (err) {
          reject(new Error(`音频格式转换失败: ${err.message}`));
        }
      };

      reader.onerror = () => {
        reject(new Error('读取音频文件失败'));
      };

      reader.readAsArrayBuffer(audioBlob);
    });
  }, []);

  /**
   * AudioBuffer转WAV格式
   */
  const audioBufferToWav = (audioBuffer) => {
    const length = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const numberOfChannels = audioBuffer.numberOfChannels;
    const bytesPerSample = 2;
    const blockAlign = numberOfChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = length * blockAlign;
    const bufferSize = 44 + dataSize;

    const buffer = new ArrayBuffer(bufferSize);
    const view = new DataView(buffer);

    // WAV文件头
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, bufferSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    // 音频数据
    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(channel)[i]));
        view.setInt16(offset, sample * 0x7FFF, true);
        offset += 2;
      }
    }

    return buffer;
  };

  /**
   * 处理当前音频段
   */
  const processChunk = useCallback(async (isFinal = false) => {
    // 防重复处理
    if (processingRef.current) {
      if (window.electronAPI && window.electronAPI.log) {
        window.electronAPI.log('info', '⏭️ 上一个分段还在处理中，跳过本次处理');
      }
      return;
    }

    // 检查是否有足够的音频数据
    const totalSize = audioChunksRef.current.reduce((sum, chunk) => sum + chunk.size, 0);
    if (totalSize < MIN_CHUNK_SIZE && !isFinal) {
      if (window.electronAPI && window.electronAPI.log) {
        window.electronAPI.log('info', `⏭️ 音频数据不足 (${totalSize} bytes)，跳过`);
      }
      return;
    }

    if (audioChunksRef.current.length === 0 && !isFinal) {
      return;
    }

    processingRef.current = true;
    const startTime = Date.now();

    try {
      // 创建音频Blob
      const chunks = [...audioChunksRef.current];
      const audioBlob = new Blob(chunks, {
        type: 'audio/webm;codecs=opus'
      });

      // 检查音频时长（估算）
      const estimatedDuration = (Date.now() - lastProcessTimeRef.current) / 1000;
      if (estimatedDuration < MIN_AUDIO_DURATION && !isFinal) {
        if (window.electronAPI && window.electronAPI.log) {
          window.electronAPI.log('info', `⏭️ 音频时长不足 ${estimatedDuration.toFixed(2)}s，跳过`);
        }
        processingRef.current = false;
        return;
      }

      // 转换为WAV
      const wavBlob = await convertToWav(audioBlob);
      const arrayBuffer = await wavBlob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // 发送转录请求
      const chunkId = ++chunkCounterRef.current;

      if (window.electronAPI && window.electronAPI.log) {
        window.electronAPI.log('info', `🎙️ 处理第 ${chunkId} 个音频段，大小: ${uint8Array.length} bytes, isFinal: ${isFinal}`);
      }

      const result = await window.electronAPI.transcribeAudioChunk({
        audioData: uint8Array,
        chunkId: chunkId,
        isFinal: isFinal,
        timestamp: Date.now()
      });

      if (result.success && result.text && result.text.trim()) {
        const processingTime = Date.now() - startTime;

        if (window.electronAPI && window.electronAPI.log) {
          window.electronAPI.log('info', `✅ 分段 ${chunkId} 转录成功，耗时: ${processingTime}ms, 文本: ${result.text}`);
        }

        // 更新部分结果
        setPartialResults(prev => {
          const newResults = [...prev, {
            id: chunkId,
            text: result.text,
            timestamp: Date.now(),
            duration: result.duration || 0,
            processingTime: processingTime,
            isFinal: isFinal
          }];

          // 更新累积文本
          const newAllText = newResults.map(r => r.text).join('');
          setAllText(newAllText);

          // 触发回调
          if (window.onPartialTranscription) {
            window.onPartialTranscription({
              chunkId,
              text: result.text,
              allText: newAllText,
              chunks: newResults,
              isFinal: isFinal
            });
          }

          return newResults;
        });

        // 清空已处理的音频块
        audioChunksRef.current = [];
        lastProcessTimeRef.current = Date.now();
      } else {
        if (window.electronAPI && window.electronAPI.log) {
          window.electronAPI.log('warn', `⚠️ 分段 ${chunkId} 转录无结果或文本为空`);
        }
        // 即使没有结果也清空音频块，避免累积
        audioChunksRef.current = [];
      }

    } catch (error) {
      if (window.electronAPI && window.electronAPI.log) {
        window.electronAPI.log('error', `❌ 分段处理异常: ${error.message}`);
      }
      setError(`分段转录失败: ${error.message}`);
      // 发生错误时也清空音频块
      audioChunksRef.current = [];
    } finally {
      processingRef.current = false;
    }
  }, [convertToWav]);

  /**
   * 开始分段录音
   */
  const startChunkedRecording = useCallback(async () => {
    try {
      setError(null);

      // 检查FunASR是否就绪
      if (!modelStatus.isReady) {
        if (modelStatus.isLoading) {
          throw new Error('FunASR服务器正在启动中，请稍候...');
        } else if (modelStatus.error) {
          throw new Error('FunASR服务器未就绪，请检查配置');
        } else {
          throw new Error('正在准备FunASR服务器，请稍候...');
        }
      }

      // 检查浏览器支持
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('您的浏览器不支持录音功能');
      }

      // 请求麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      streamRef.current = stream;
      audioChunksRef.current = [];
      chunkCounterRef.current = 0;
      lastProcessTimeRef.current = Date.now();

      // 清空之前的结果
      setPartialResults([]);
      setAllText('');

      // 创建MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      mediaRecorderRef.current = mediaRecorder;

      // 收集音频数据
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // 错误处理
      mediaRecorder.onerror = (event) => {
        setError(`录音错误: ${event.error?.message || '未知错误'}`);
        setIsStreaming(false);
      };

      // 启动录音（每100ms收集一次数据）
      mediaRecorder.start(100);
      setIsStreaming(true);

      if (window.electronAPI && window.electronAPI.log) {
        window.electronAPI.log('info', '🎤 分段录音已启动');
      }

      // 启动分段处理定时器
      chunkTimerRef.current = setInterval(() => {
        processChunk(false);
      }, CHUNK_INTERVAL);

      return { mediaRecorder, stream };

    } catch (err) {
      setError(`无法开始录音: ${err.message}`);
      setIsStreaming(false);
      throw err;
    }
  }, [modelStatus.isReady, modelStatus.isLoading, modelStatus.error, processChunk]);

  /**
   * 停止分段录音
   */
  const stopChunkedRecording = useCallback(async () => {
    try {
      // 停止定时器
      if (chunkTimerRef.current) {
        clearInterval(chunkTimerRef.current);
        chunkTimerRef.current = null;
      }

      // 停止录音
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }

      // 停止音频流
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }

      // 等待最后的数据
      await new Promise(resolve => setTimeout(resolve, 300));

      // 处理最后一个分段
      if (audioChunksRef.current.length > 0) {
        if (window.electronAPI && window.electronAPI.log) {
          window.electronAPI.log('info', '🔚 处理最后一个音频段');
        }
        await processChunk(true);
      }

      setIsStreaming(false);

      // 等待一下确保最后的结果已更新
      await new Promise(resolve => setTimeout(resolve, 100));

      // 返回最终结果
      const finalText = allText;
      const totalDuration = partialResults.reduce((sum, r) => sum + r.duration, 0);

      if (window.electronAPI && window.electronAPI.log) {
        window.electronAPI.log('info', `✅ 分段录音完成，共 ${partialResults.length} 个分段，总文本: ${finalText}`);
      }

      return {
        success: true,
        text: finalText,
        chunks: partialResults.length,
        duration: totalDuration,
        partialResults: partialResults
      };

    } catch (err) {
      setError(`停止录音失败: ${err.message}`);
      throw err;
    }
  }, [allText, partialResults, processChunk]);

  /**
   * 取消录音
   */
  const cancelChunkedRecording = useCallback(() => {
    // 停止定时器
    if (chunkTimerRef.current) {
      clearInterval(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }

    // 停止录音
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    // 停止音频流
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    setIsStreaming(false);
    setPartialResults([]);
    setAllText('');
    setError(null);
    audioChunksRef.current = [];
  }, []);

  return {
    isStreaming,
    partialResults,
    allText,
    error,
    startChunkedRecording,
    stopChunkedRecording,
    cancelChunkedRecording
  };
};
