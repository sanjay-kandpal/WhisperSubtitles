// transcriberWorker.js

import { pipeline } from "@huggingface/transformers";

let transcriber = null;
let processedChunks = [];
let totalChunks = 0;

// Main message handler
self.onmessage = async function (event) {
    const { type, modelPath, audioBuffer, language, chunkIndex, totalChunks: incomingTotalChunks } = event.data;
    
    try {
        switch (type) {
            case 'fullAudio':
                await processFullAudio(modelPath, audioBuffer, language);
                break;
            case 'chunk':
                await processChunk(modelPath, audioBuffer, language, chunkIndex, incomingTotalChunks);
                break;
            case 'allChunksComplete':
                finalizeResults();
                break;
            default:
                throw new Error(`Unknown message type: ${type}`);
        }
    } catch (error) {
        postError(`Worker error: ${error.message}`);
        console.error('Worker error:', error);
    }
};

// Helper function to post error messages
function postError(message) {
    self.postMessage({ type: 'error', message });
}

// Helper function to post log messages
function postLog(message) {
    self.postMessage({ type: 'log', message });
}

// Helper function to post progress updates
function postProgress(value, message) {
    self.postMessage({ type: 'progress', value, message });
}

// Load the transcription model
async function loadModel(modelPath) {
    postLog(`Starting to load model: ${modelPath}`);
    
    let lastProgress = 0;
    transcriber = await pipeline('automatic-speech-recognition', modelPath, {
        quantized: true,
        fp16: true, // Use half-precision for better performance
        progress_callback: (progress) => {
            const currentProgress = Math.round(progress * 100);
            if (currentProgress > lastProgress) {
                lastProgress = currentProgress;
                postProgress(currentProgress, `Model loading progress: ${currentProgress}%`);
            }
        }
    });
    
    postLog('Model loaded successfully');
}

// Process full audio
async function processFullAudio(modelPath, audioBuffer, language) {
    if (!transcriber) {
        await loadModel(modelPath);
    }

    postLog('Starting transcription...');
    
    const audioData = prepareAudioData(audioBuffer);
    postLog('Audio prepared. Processing transcription...');
    
    const transcriptionTimeout = 300000; // 5 minutes
    const result = await Promise.race([
        transcriber(audioData, {
            language,
            task: 'transcribe',
            return_timestamps: true,
            chunk_length_s: 5, // Increased from 5 for better performance
            stride_length_s: 2, // Decreased for better accuracy
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Transcription timed out')), transcriptionTimeout))
    ]);
    
    postLog('Transcription complete');
    
    const subtitles = processTranscriptionResult(result);
    self.postMessage({ type: 'result', subtitles });
    
    // Clean up memory
    cleanupMemory(audioData, result);
}

// Process a single chunk of audio
async function processChunk(modelPath, audioBuffer, language, chunkIndex, incomingTotalChunks) {
    if (!transcriber) {
        await loadModel(modelPath);
    }

    if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error('Invalid audio data received');
    }
    
    postLog(`Processing chunk ${chunkIndex + 1} of ${incomingTotalChunks}...`);
    
    const audioData = prepareAudioData(audioBuffer);
    const result = await transcriber(audioData, {
        language,
        task: 'transcribe',
        return_timestamps: true,
        chunk_length_s: 10, // Increased from 5 for better performance
        stride_length_s: 1, // Decreased for better accuracy
    });
    
    // Process the transcription result into subtitle format
    let subtitles = processTranscriptionResult(result);
    
    // Calculate and apply time offset based on chunk position
    // Assuming each chunk is 30 seconds of audio
    const chunkDurationInSeconds = 30; // Adjust this based on your actual chunk size
    const timeOffset = chunkIndex * chunkDurationInSeconds;
    
    subtitles = subtitles.map(subtitle => ({
        ...subtitle,
        start: subtitle.start + timeOffset,
        end: subtitle.end + timeOffset
    }));
    
    postLog(`Chunk ${chunkIndex + 1} processed with ${subtitles.length} subtitle segments`);
    
    // Save processed chunk results
    processedChunks[chunkIndex] = subtitles;
    totalChunks = incomingTotalChunks;
    
    // Send progress update
    self.postMessage({ 
        type: 'chunkComplete', 
        chunkIndex,
        subtitles, // Include subtitles in the message for immediate use if needed
        progress: Math.round(((chunkIndex + 1) / totalChunks) * 100)
    });
    
    // Clean up memory
    cleanupMemory(audioData, result);
}

// Finalize results after all chunks are processed
function finalizeResults() {
    if (processedChunks.length === 0) {
        postError('No chunks were processed successfully');
        return;
    }
    
    // Flatten all subtitle chunks into one array
    let allSubtitles = [];
    processedChunks.forEach(subtitles => {
        if (subtitles && subtitles.length > 0) {
            allSubtitles = allSubtitles.concat(subtitles);
        }
    });
    
    // Sort subtitles by start time
    allSubtitles.sort((a, b) => a.start - b.start);
    
    // Merge overlapping or very close subtitles
    const mergedSubtitles = mergeOverlappingSubtitles(allSubtitles);
    
    // Reassign IDs to ensure they're sequential
    const finalSubtitles = mergedSubtitles.map((subtitle, index) => ({
        ...subtitle,
        id: index + 1
    }));
    
    // Send the final result
    self.postMessage({ type: 'result', subtitles: finalSubtitles });
    
    // Clear the chunks array for future use
    processedChunks = [];
    totalChunks = 0;
    
    postLog('All chunks have been processed and merged successfully');
}

// Process transcription results into subtitle entries
function processTranscriptionResult(result) {
    const subtitleEntries = [];
    
    // Check if result contains chunks (timestamps)
    if (result && result.chunks && result.chunks.length > 0) {
        result.chunks.forEach((chunk, index) => {
            // Ensure timestamps exist and are valid
            if (chunk.timestamp && chunk.timestamp.length >= 2 && 
                typeof chunk.timestamp[0] === 'number' && 
                typeof chunk.timestamp[1] === 'number') {
                
                subtitleEntries.push({
                    id: index + 1,
                    start: chunk.timestamp[0],
                    end: chunk.timestamp[1],
                    text: chunk.text.trim(),
                    font: 'Arial',
                    fontSize: '24px',
                    color: '#FFFFFF'
                });
            }
        });
    } 
    // Fallback if no chunks with timestamps
    else if (result && result.text) {
        // Create a basic subtitle entry with estimated duration
        subtitleEntries.push({
            id: 1,
            start: 0,
            end: 30, // Default duration
            text: result.text.trim(),
            font: 'Arial',
            fontSize: '24px',
            color: '#FFFFFF'
        });
    }
    
    return subtitleEntries;
}

// Merge overlapping subtitles
function mergeOverlappingSubtitles(subtitles) {
    if (!subtitles || subtitles.length <= 1) return subtitles;
    
    const merged = [];
    let current = subtitles[0];
    
    for (let i = 1; i < subtitles.length; i++) {
        const next = subtitles[i];
        
        // If current and next overlap or are very close (within 0.3 seconds)
        if (next.start <= current.end + 0.3) {
            // Merge them
            current = {
                ...current,
                end: Math.max(current.end, next.end),
                text: current.text + ' ' + next.text
            };
        } else {
            // No overlap, add current to results and move to next
            merged.push(current);
            current = next;
        }
    }
    
    // Add the last item
    merged.push(current);
    
    return merged;
}

// Prepare audio data for processing
function prepareAudioData(audioBuffer) {
    let audioData;
    
    if (audioBuffer instanceof ArrayBuffer) {
        const originalLength = audioBuffer.byteLength;
        const paddedLength = Math.ceil(originalLength / 4) * 4;
        
        if (originalLength !== paddedLength) {
            const paddedBuffer = new ArrayBuffer(paddedLength);
            const view = new Uint8Array(paddedBuffer);
            view.set(new Uint8Array(audioBuffer));
            audioData = new Float32Array(paddedBuffer);
        } else {
            audioData = new Float32Array(audioBuffer);
        }
    } else if (audioBuffer.buffer && audioBuffer.buffer instanceof ArrayBuffer) {
        audioData = audioBuffer;
    } else {
        throw new Error('Invalid audio data format');
    }
    
    if (audioData.length === 0) {
        throw new Error('Audio data is empty');
    }
    
    // Attempt to perform audio downsampling if the buffer is very large
    // to improve processing speed
    if (audioData.length > 1000000) { // If more than ~20 seconds at 48kHz
        audioData = downsampleAudio(audioData);
        postLog('Downsampled audio to reduce processing time');
    }
    
    return audioData;
}

// Downsample audio to improve processing speed
function downsampleAudio(audioData, originalSampleRate = 48000, targetSampleRate = 16000) {
    // Simple downsampling - take every Nth sample
    const ratio = Math.floor(originalSampleRate / targetSampleRate);
    if (ratio <= 1) return audioData; // No downsampling needed
    
    const result = new Float32Array(Math.ceil(audioData.length / ratio));
    for (let i = 0; i < result.length; i++) {
        result[i] = audioData[i * ratio];
    }
    
    return result;
}

// Clean up memory to prevent leaks
function cleanupMemory(audioData, result) {
    // Explicitly nullify large objects
    if (audioData) audioData = null;
    if (result) result = null;
    
    // Attempt to force garbage collection if available
    if (typeof gc !== 'undefined') {
        try {
            gc();
        } catch (e) {
            // gc might not be available, silently continue
        }
    }
}