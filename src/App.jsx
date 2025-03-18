import React, { useState, useRef, useEffect } from 'react';

import { env } from '@huggingface/transformers';
import {  fetchFile } from '@ffmpeg/util';
// import createFFmpeg from '@ffmpeg/ffmpeg';
import MyWorker from './transcriberWorker?worker'
import { FFmpeg } from '@ffmpeg/ffmpeg';

function App() {
  // Main state variables
  const [video, setVideo] = useState(null);
  const [videoName, setVideoName] = useState('');
  const [selectedModel, setSelectedModel] = useState('base');
  const [selectedLanguage, setSelectedLanguage] = useState('en');
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [modelLoadingProgress, setModelLoadingProgress] = useState(0);
  const [subtitles, setSubtitles] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [videoAspectRatio, setVideoAspectRatio] = useState('16/9');
  const [selectedSubtitle, setSelectedSubtitle] = useState(null);
  const [subtitleFont, setSubtitleFont] = useState('Arial');
  const [subtitleFontSize, setSubtitleFontSize] = useState('24px');
  const [subtitleColor, setSubtitleColor] = useState('#FFFFFF');
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [showSetupScreen, setShowSetupScreen] = useState(true);

  // Refs
  const videoRef = useRef(null);
  const transcriber = useRef(null);
  const canvasRef = useRef(null);
  const contextRef = useRef(null);
  const workerRef = useRef(null);
  useEffect(() => {
    // Configure the environment settings
    env.allowLocalModels = false;
    
  }, [])
  
  // Logger for debugging
  
  const [logs, setLogs] = useState([]);
  const addLog = (message) => {
    console.log(message);
    setLogs(prev => [...prev, `${new Date().toLocaleTimeString()}: ${message}`]);
  };

  // Model configurations
  const modelConfigs = {
    base: {
      name: 'Whisper-tiny',
      path: 'Xenova/whisper-tiny.en',
      size: '~75MB' 
    },
    large: {
      name: 'Whisper-medium',
      path: 'distil-whisper/distil-large-v2',
      size: '~1.5GB'
    }
  };

  // Font options
  const fontOptions = [
    'Arial', 'Verdana', 'Helvetica', 'Tahoma', 'Trebuchet MS', 
    'Times New Roman', 'Georgia', 'Garamond', 'Courier New', 'Brush Script MT'
  ];

  // Video aspect ratio options
  const aspectRatioOptions = {
    '16/9': { label: '16:9 (Widescreen)', value: '16/9' },
    '4/3': { label: '4:3 (Standard)', value: '4/3' },
    '1/1': { label: '1:1 (Square)', value: '1/1' },
    '9/16': { label: '9:16 (Vertical)', value: '9/16' }
  };

  // Handle file upload
  // In your handleFileUpload function:
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      setIsVideoLoading(true);
      const videoURL = URL.createObjectURL(file);
      setVideo(videoURL);
      setVideoName(file.name);
      addLog(`Video loading: ${file.name}`);
      
      // Create a video element and load the file
      const videoElement = document.createElement('video');
      videoElement.src = videoURL;
      videoElement.preload = 'auto';
      
      // Set up event listeners
      videoElement.addEventListener('loadeddata', () => {
        addLog('Video data loaded');
        setIsVideoLoading(false);
        
        // Store the video element reference
        videoRef.current = videoElement;
        
        // Trigger preload
        videoElement.play().then(() => {
          videoElement.pause();
          videoElement.currentTime = 0;
          addLog('Video preloaded');
        }).catch(err => {
          addLog(`Error preloading video: ${err.message}`);
        });
      });
      
      videoElement.addEventListener('error', (e) => {
        addLog(`Video loading error: ${e.message}`);
        setIsVideoLoading(false);
        alert('Failed to load the video. Please try a different file.');
      });
      
      // Start loading
      videoElement.load();
    }
  };

  
  // Fallback function using Web Audio API
const extractAudioWithWebAudio = async (videoUrl) => {
  try {
    addLog('Starting audio extraction with Web Audio API (fallback)');
    
    // Fetch the video
    const response = await fetch(videoUrl);
    const arrayBuffer = await response.arrayBuffer();
    
    // Create an AudioContext
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Decode the audio data
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Resample to 16kHz if necessary
    if (audioBuffer.sampleRate !== 16000) {
      addLog('Resampling audio to 16kHz');
      const offlineContext = new OfflineAudioContext(1, audioBuffer.duration * 16000, 16000);
      const source = offlineContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(offlineContext.destination);
      source.start();
      const resampledBuffer = await offlineContext.startRendering();
      return new Float32Array(resampledBuffer.getChannelData(0));
    }
    
    // Return the audio data as Float32Array
    addLog('Audio extraction complete with Web Audio API');
    return new Float32Array(audioBuffer.getChannelData(0));
  } catch (error) {
    addLog(`Web Audio API extraction failed: ${error.message}`);
    console.error('Web Audio API detailed error:', error);
    throw error;
  }
};
const generateSubtitles = async () => {
  try {
    setIsModelLoading(true);
    setModelLoadingProgress(0);
    setShowSetupScreen(false);
    
    const modelPath = selectedModel === 'base' 
      ? 'Xenova/whisper-tiny' 
      : 'distil-whisper/distil-large-v2';
    
    addLog(`Initializing Parallel Transcription Manager for model: ${modelPath}`);
    
    // Create a new ParallelTranscriptionManager instead of a single worker
    const numWorkers = navigator.hardwareConcurrency || 4;
    addLog(`Using ${numWorkers} workers for parallel processing`);
    
    import('./TranscriptionManager.js').then(async (module) => {
      const ParallelTranscriptionManager = module.default;
      const transcriptionManager = new ParallelTranscriptionManager(
        modelPath,
        selectedLanguage,
        numWorkers
      ).initialize();
      
      // Set up progress callback
      transcriptionManager.onProgress((progress, message) => {
        console.log(`Progress: ${progress}% - ${message}`);
        if (message.includes('Model loading')) {
          setModelLoadingProgress(progress);
        } else {
          setIsProcessing(true);
          setProcessingProgress(progress);
        }
        addLog(message);
      });
      
      let audioBuffer;
      
        try {
          audioBuffer = await extractAudioWithWebAudio(videoRef.current.src);
          addLog('Extracted audio from video using Web Audio API');
        } catch (webAudioError) {
          console.log(webAudioError);
          
          addLog('Both extraction methods failed');
          throw new Error('Audio extraction failed using both FFmpeg and Web Audio API');
        }
      
      
      // Set up timeout for stalled processing
      const processingTimeout = setTimeout(() => {
        if (isModelLoading) {
          addLog("Processing appears to be stalled. The audio might be too large or complex.");
          alert("Processing timed out. Please try with a shorter video or the smaller model.");
          setIsModelLoading(false);
          setShowSetupScreen(true);
          transcriptionManager.terminate();
        }
      }, 120000); // 2 minute timeout
      
      try {
        // Start transcription with parallel processing
        const subtitles = await transcriptionManager.transcribe(audioBuffer, 16000);
        
        setSubtitles(subtitles);
        setIsModelLoading(false);
        addLog(`Generated ${subtitles.length} subtitle segments`);
        setProcessingProgress(100);
        setIsProcessing(false);
        
        // Clean up
        transcriptionManager.terminate();
        clearTimeout(processingTimeout);
      } catch (error) {
        console.error('Transcription error:', error);
        addLog(`Transcription error: ${error.message}`);
        alert(`Error during transcription: ${error.message}`);
        setIsModelLoading(false);
        setShowSetupScreen(true);
        transcriptionManager.terminate();
        clearTimeout(processingTimeout);
      }
    }).catch(error => {
      console.error('Failed to load ParallelTranscriptionManager:', error);
      alert(`Failed to initialize parallel processing: ${error.message}`);
      setIsModelLoading(false);
      setShowSetupScreen(true);
    });
    
  } catch (error) {
    setIsModelLoading(false);
    addLog(`Error loading model: ${error.message}`);
    console.error('Detailed error:', error);
    
    // Display an alert to the user
    alert(`Failed to load the model: ${error.message}. Please try again or choose a different model.`);
    setShowSetupScreen(true); // Return to setup screen on error
  }
};
  

  // Format time for display (HH:MM:SS,mmm)
  const formatSRTTime = (seconds) => {
    if (isNaN(seconds)) seconds = 0;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };

  // Download subtitles as SRT
  const downloadSubtitles = () => {
    if (subtitles.length === 0) return;
    
    let srtContent = '';
    subtitles.forEach((subtitle) => {
      const startTime = formatSRTTime(subtitle.start);
      const endTime = formatSRTTime(subtitle.end);
      
      srtContent += `${subtitle.id}\n`;
      srtContent += `${startTime} --> ${endTime}\n`;
      srtContent += `${subtitle.text}\n\n`;
    });
    
    const blob = new Blob([srtContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = videoName.replace(/\.[^/.]+$/, '') + '.srt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Update subtitle text
  const updateSubtitleText = (id, newText) => {
    setSubtitles(subs => 
      subs.map(sub => (sub.id === id ? { ...sub, text: newText } : sub))
    );
  };

  // Update subtitle styling for all subtitles
  const updateAllSubtitleStyling = (property, value) => {
    setSubtitles(subs => 
      subs.map(sub => ({ ...sub, [property]: value }))
    );
  };

  // Handle video time update
  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    
    const currentTime = videoRef.current.currentTime;
    
    // Find current subtitle
    const current = subtitles.find(
      sub => currentTime >= sub.start && currentTime <= sub.end
    );
    
    // Draw subtitle on canvas overlay if exists
    if (canvasRef.current && contextRef.current) {
      const ctx = contextRef.current;
      const canvas = canvasRef.current;
      
      // Clear previous subtitles
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // If there's a current subtitle, draw it
      if (current) {
        ctx.font = `${current.fontSize} ${current.font}`;
        ctx.fillStyle = current.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        
        // Draw subtitle text with shadow for better visibility
        ctx.shadowColor = 'black';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
        
        // Handle multiline text
        const lines = current.text.split('\n');
        const lineHeight = parseInt(current.fontSize) * 1.2;
        
        lines.forEach((line, index) => {
          ctx.fillText(
            line, 
            canvas.width / 2, 
            canvas.height - 30 - (lines.length - 1 - index) * lineHeight
          );
        });
      }
    }
  };

  // Initialize canvas when video loads
  const handleVideoLoad = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      // Set canvas dimensions to match video
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      // Get and store the canvas context
      contextRef.current = canvas.getContext('2d');
      
      setIsVideoLoading(false);
      addLog('Video loaded and ready');
    }
  };
  
  // Apply aspect ratio to video container
  const getAspectRatioStyle = () => {
    const [width, height] = videoAspectRatio.split('/');
    return {
      aspectRatio: videoAspectRatio,
      maxWidth: '100%',
      maxHeight: '70vh'
    };
  };

  // Download video with subtitles
  const downloadVideoWithSubtitles = async () => {
    addLog('Starting video export with subtitles...');
    
    try {
      // This is a simplified approach - in a real application you'd need to
      // use a library like ffmpeg.wasm for proper video processing
      alert('Video export functionality requires additional libraries. In a production app, this would use ffmpeg.wasm to create a video with burned-in subtitles.');
      
      // Mockup of what would happen:
      addLog('For a complete implementation, you would need to:');
      addLog('1. Use ffmpeg.wasm to process the video frame by frame');
      addLog('2. Draw subtitles on each frame at the correct timestamp');
      addLog('3. Re-encode the video with the subtitles burned in');
      addLog('4. Create a downloadable file');
    } catch (error) {
      addLog(`Error exporting video: ${error.message}`);
    }
  };

  // Setup screen (step 1)
  const renderSetupScreen = () => (
    <div className="max-w-4xl mx-auto p-4">
      <h1 className="text-3xl font-bold mb-6">Video Subtitle Generator</h1>
      
      <div className="mb-6 p-4 bg-gray-50 rounded-lg border">
        <h2 className="text-xl font-semibold mb-4">Step 1: Upload Video and Configure Settings</h2>
        
        <div className="mb-4">
          <label className="block mb-2 font-medium">Upload Video:</label>
          <input 
            type="file" 
            accept="video/*" 
            onChange={handleFileUpload}
            className="block w-full text-sm text-gray-500
              file:mr-4 file:py-2 file:px-4
              file:rounded-md file:border-0
              file:text-sm file:font-semibold
              file:bg-blue-50 file:text-blue-700
              hover:file:bg-blue-100"
          />
        </div>
        
        {video && (
          <>
            <div className="mb-4">
              <label className="block mb-2 font-medium">Selected Video:</label>
              <div className="p-2 bg-blue-50 rounded">
                {videoName}
              </div>
              {isVideoLoading ? (
              <div className="mt-2 p-2 bg-yellow-100 rounded border border-yellow-300 text-yellow-700">
                Loading video... Please wait.
              </div>
            ) : (
              <video 
                src={video} 
                className="mt-2 max-h-40 border rounded" 
                
                controls 
                preload="auto"
              />
            )}
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block mb-2 font-medium">Select Model:</label>
                <div className="space-y-2">
                  <div className="flex items-center">
                    <input
                      type="radio"
                      id="model-base"
                      name="model"
                      value="base"
                      checked={selectedModel === 'base'}
                      onChange={() => setSelectedModel('base')}
                      className="mr-2"
                    />
                    <label htmlFor="model-base">
                      <span className="font-medium">{modelConfigs.base.name}</span>
                      <span className="text-sm text-gray-500 ml-2">({modelConfigs.base.size})</span>
                      <p className="text-xs text-gray-500">Faster, less accurate, smaller download</p>
                    </label>
                  </div>
                  
                  <div className="flex items-center">
                    <input
                      type="radio"
                      id="model-large"
                      name="model"
                      value="large"
                      checked={selectedModel === 'large'}
                      onChange={() => setSelectedModel('large')}
                      className="mr-2"
                    />
                    <label htmlFor="model-large">
                      <span className="font-medium">{modelConfigs.large.name}</span>
                      <span className="text-sm text-gray-500 ml-2">({modelConfigs.large.size})</span>
                      <p className="text-xs text-gray-500">More accurate, longer processing time, larger download</p>
                    </label>
                  </div>
                </div>
              </div>
              
              <div>
                <label className="block mb-2 font-medium">Video Language:</label>
                <select
                  value={selectedLanguage}
                  onChange={(e) => setSelectedLanguage(e.target.value)}
                  className="w-full p-2 border rounded"
                >
                  <option value="en">English</option>
                  <option value="es">Spanish</option>
                  <option value="fr">French</option>
                  <option value="de">German</option>
                  <option value="it">Italian</option>
                  <option value="ja">Japanese</option>
                  <option value="ko">Korean</option>
                  <option value="zh">Chinese</option>
                  <option value="hi">Hindi</option>
                  <option value="ru">Russian</option>
                  <option value="pt">Portuguese</option>
                  <option value="ar">Arabic</option>
                </select>
              </div>
            </div>
            
            <button
              onClick={generateSubtitles}
              disabled={!video}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:bg-gray-400"
            >
              Create Subtitles
            </button>
          </>
        )}
      </div>
    </div>
  );

  // Processing screen (step 2 & 3)
  const renderProcessingScreen = () => (
    <div className="max-w-4xl mx-auto p-4">
      <h1 className="text-3xl font-bold mb-6">Video Subtitle Generator</h1>
      
      <div className="mb-6 p-6 bg-gray-50 rounded-lg border text-center">
        {isModelLoading ? (
          <>
            <h2 className="text-xl font-semibold mb-4">Downloading {modelConfigs[selectedModel].name}...</h2>
            <div className="mb-4 h-4 bg-gray-200 rounded-full">
              <div 
                className="h-4 bg-blue-600 rounded-full transition-all duration-300" 
                style={{ width: `${modelLoadingProgress}%` }}
              />
            </div>
            <p className="text-gray-700">{modelLoadingProgress}% Complete</p>
            <p className="text-sm text-gray-500 mt-2">This model will be cached in your browser for future use</p>
          </>
        ) : isProcessing ? (
          <>
            <h2 className="text-xl font-semibold mb-4">Generating Subtitles...</h2>
            <div className="mb-4 h-4 bg-gray-200 rounded-full">
              <div 
                className="h-4 bg-green-600 rounded-full transition-all duration-300" 
                style={{ width: `${processingProgress}%` }}
              />
            </div>
            <p className="text-gray-700">{processingProgress}% Complete</p>
            <p className="text-sm text-gray-500 mt-2">Analyzing audio and generating transcription</p>
          </>
        ) : subtitles.length > 0 ? (
          <div className="text-center">
            <h2 className="text-xl font-semibold mb-4">Success!</h2>
            <p className="text-green-600 text-lg mb-4">Generated {subtitles.length} subtitle segments</p>
            <button
              onClick={() => setShowSetupScreen(true)}
              className="px-4 py-2 bg-gray-600 text-white rounded-lg mr-2"
            >
              Back to Setup
            </button>
            <button
  onClick={() => {
    setShowSetupScreen(false);
  }}
  className="px-4 py-2 bg-blue-600 text-white rounded-lg"
>
  Continue to Editor
</button>
          </div>
        ) : (
          <div className="text-center">
            <h2 className="text-xl font-semibold mb-4">Something went wrong</h2>
            <p className="text-red-600 mb-4">No subtitles were generated. Please check the logs below.</p>
            <button
              onClick={() => setShowSetupScreen(true)}
              className="px-4 py-2 bg-gray-600 text-white rounded-lg"
            >
              Back to Setup
            </button>
          </div>
        )}
      </div>
      
      {/* Logs */}
      <div className="mb-4">
        <h3 className="font-medium mb-2">Process Logs:</h3>
        <div className="bg-black text-green-400 p-3 rounded-lg max-h-40 overflow-y-auto text-sm font-mono">
          {logs.map((log, index) => (
            <div key={index}>{log}</div>
          ))}
        </div>
      </div>
    </div>
  );
  
  // Editor screen (step 4)
  const renderEditorScreen = () => (
    <div className="max-w-6xl mx-auto p-4">
      <h1 className="text-3xl font-bold mb-6">Subtitle Editor</h1>
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Video with subtitles */}
        <div className="lg:col-span-2">
          <div className="relative" style={getAspectRatioStyle()}>
            <video
              ref={videoRef}
              src={video}
              className="w-full h-full object-contain bg-black"
              controls
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleVideoLoad}
            />
            <canvas
              ref={canvasRef}
              className="absolute top-0 left-0 w-full h-full pointer-events-none"
            />
          </div>
          
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
            <div>
              <label className="block text-sm mb-1">Aspect Ratio:</label>
              <select
                value={videoAspectRatio}
                onChange={(e) => setVideoAspectRatio(e.target.value)}
                className="w-full p-2 border rounded text-sm"
              >
                {Object.entries(aspectRatioOptions).map(([value, option]) => (
                  <option key={value} value={value}>{option.label}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label className="block text-sm mb-1">Font:</label>
              <select
                value={subtitleFont}
                onChange={(e) => {
                  setSubtitleFont(e.target.value);
                  updateAllSubtitleStyling('font', e.target.value);
                }}
                className="w-full p-2 border rounded text-sm"
              >
                {fontOptions.map(font => (
                  <option key={font} value={font}>{font}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label className="block text-sm mb-1">Font Size:</label>
              <select
                value={subtitleFontSize}
                onChange={(e) => {
                  setSubtitleFontSize(e.target.value);
                  updateAllSubtitleStyling('fontSize', e.target.value);
                }}
                className="w-full p-2 border rounded text-sm"
              >
                <option value="16px">Small (16px)</option>
                <option value="24px">Medium (24px)</option>
                <option value="32px">Large (32px)</option>
                <option value="40px">X-Large (40px)</option>
              </select>
            </div>
            
            <div>
              <label className="block text-sm mb-1">Color:</label>
              <input
                type="color"
                value={subtitleColor}
                onChange={(e) => {
                  setSubtitleColor(e.target.value);
                  updateAllSubtitleStyling('color', e.target.value);
                }}
                className="w-full p-1 border rounded h-9"
              />
            </div>
          </div>
          
          <div className="flex gap-2 mt-4">
            <button
              onClick={downloadSubtitles}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded"
            >
              Download SRT
            </button>
            
            <button
              onClick={downloadVideoWithSubtitles}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded"
            >
              Export Video with Subtitles
            </button>
          </div>
        </div>
        
        {/* Right column: Subtitle list */}
        <div>
          <h2 className="text-xl font-medium mb-2">Edit Subtitles</h2>
          <div className="border rounded-lg max-h-[70vh] overflow-y-auto">
            {subtitles.map((subtitle) => (
              <div 
                key={subtitle.id} 
                className={`p-3 border-b ${selectedSubtitle === subtitle.id ? 'bg-blue-50' : ''}`}
                onClick={() => setSelectedSubtitle(subtitle.id)}
              >
                <div className="flex justify-between text-sm text-gray-500 mb-1">
                  <span>{formatSRTTime(subtitle.start)}</span>
                  <span>→</span>
                  <span>{formatSRTTime(subtitle.end)}</span>
                </div>
                
                <textarea
                  value={subtitle.text}
                  onChange={(e) => updateSubtitleText(subtitle.id, e.target.value)}
                  className="w-full p-2 border rounded text-sm min-h-[60px]"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  // Main render function
  return (
    <div className="min-h-screen bg-gray-100 py-8">
      {showSetupScreen ? (
        renderSetupScreen()
      ) : (
        isModelLoading || isProcessing || !subtitles.length ? (
          renderProcessingScreen()
        ) : (
          renderEditorScreen()
        )
      )}
    </div>
  );
}

export default App;