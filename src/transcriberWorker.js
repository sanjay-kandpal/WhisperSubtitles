// transcriberWorker.js

import { pipeline } from "@huggingface/transformers";

let transcriber = null;

self.onmessage = async function (event) {
    const { type, modelPath, audioBuffer, language, chunkIndex, totalChunks } = event.data;
    
    try {
        // Handle different message types
        if (type === 'fullAudio' || !type) {
            // Load model if not already loaded
            if (!transcriber) {
                await loadModel(modelPath);
            }
            
            // Process the full audio
            await processAudio(audioBuffer, language);
        } 
        else if (type === 'chunk') {
            // Load model if not already loaded
            if (!transcriber) {
                await loadModel(modelPath);
            }
            
            // Process this chunk
            await processChunk(audioBuffer, language, chunkIndex, totalChunks);
        }
        else if (type === 'allChunksComplete') {
            // All chunks have been processed, finalize results
            finalizeResults();
        }
    } catch (error) {
        self.postMessage({ type: 'error', message: `Worker error: ${error.message}` });
        console.error('Worker error:', error);
    }
};

async function loadModel(modelPath) {
    self.postMessage({ type: 'log', message: `Starting to load model: ${modelPath}` });
    
    // Add more detailed progress reporting
    let lastProgress = 0;
    transcriber = await pipeline('automatic-speech-recognition', modelPath, {
        quantized: true,
        progress_callback: (progress) => {
            console.log(progress);
            
            const currentProgress = Math.round(progress * 100);
            if (currentProgress > lastProgress) {
                lastProgress = currentProgress;
                self.postMessage({ type: 'progress', value: currentProgress });
                self.postMessage({ type: 'log', message: `Model loading progress: ${currentProgress}%` });
            }
        }
    });
    
    self.postMessage({ type: 'log', message: 'Model loaded successfully' });
}

// Store chunks for later combining
const processedChunks = [];

async function processChunk(audioBuffer, language, chunkIndex, totalChunks) {
    // Check if audio data is valid
    if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error('Invalid audio data received');
    }
    
    self.postMessage({ type: 'log', message: `Processing chunk ${chunkIndex + 1} of ${totalChunks}...` });
    
    // Convert to proper format if needed
    const audioData = prepareAudioData(audioBuffer);
    
    // Transcribe this chunk
    const result = await transcriber(audioData, {
        language: language,
        task: 'transcribe',
        return_timestamps: true,
        chunk_length_s: 5,
        stride_length_s: 2,
    });
    
    // Store the processed chunk
    processedChunks[chunkIndex] = result;
    
    // Notify that this chunk is complete
    self.postMessage({ 
        type: 'chunkComplete', 
        chunkIndex: chunkIndex,
        progress: Math.round(((chunkIndex + 1) / totalChunks) * 100)
    });
}

async function processAudio(audioBuffer, language) {
    // Check if audio data is valid
    if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error('Invalid audio data received');
    }
    
    self.postMessage({ type: 'log', message: 'Starting transcription...' });
    
    // Convert to proper format if needed
    const audioData = prepareAudioData(audioBuffer);
    
    self.postMessage({ type: 'log', message: 'Audio prepared. Processing transcription...' });
    
    // Transcribe the audio
    const transcriptionTimeout = 300000; // 5 minutes
    const result = await Promise.race([
        transcriber(audioData, {
            language: language,
            task: 'transcribe',
            return_timestamps: true,
            chunk_length_s: 5,
            stride_length_s: 2,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Transcription timed out')), transcriptionTimeout))
    ]);
    
    self.postMessage({ type: 'log', message: 'Transcription complete' });
    
    // Process the results and create subtitle entries
    const subtitles = processTranscriptionResult(result);
    
    // Send the results back to the main thread
    self.postMessage({ 
        type: 'result', 
        subtitles: subtitles 
    });
}

function finalizeResults() {
    // Combine all processed chunks into a single result
    if (processedChunks.length === 0) {
        self.postMessage({ type: 'error', message: 'No chunks were processed successfully' });
        return;
    }
    
    // Process all chunks and combine them
    const allSubtitles = [];
    let idCounter = 1;
    
    processedChunks.forEach((result, index) => {
        if (!result) return;
        
        const subtitles = processTranscriptionResult(result, idCounter);
        allSubtitles.push(...subtitles);
        idCounter += subtitles.length;
    });
    
    // Send the combined results
    self.postMessage({ 
        type: 'result', 
        subtitles: allSubtitles 
    });
    
    // Clear the chunks array for future use
    processedChunks.length = 0;
}

function processTranscriptionResult(result) {
    const subtitleEntries = [];
    
    if (result && result.chunks) {
        // For Whisper model that returns chunks with timestamps
        result.chunks.forEach((chunk, index) => {
            subtitleEntries.push({
                id: index + 1,
                start: chunk.timestamp[0],
                end: chunk.timestamp[1],
                text: chunk.text.trim(),
                font: 'Arial',
                fontSize: '24px',
                color: '#FFFFFF'
            });
        });
    } else if (result && result.text) {
        // For models that don't return chunk timestamps, use the whole text
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

function prepareAudioData(audioBuffer) {
    // Convert ArrayBuffer to Float32Array if needed
    let audioData;
    
    if (audioBuffer instanceof ArrayBuffer) {
        // Calculate the size needed for a valid Float32Array
        const originalLength = audioBuffer.byteLength;
        const paddedLength = Math.ceil(originalLength / 4) * 4;
        
        if (originalLength !== paddedLength) {
            // Need to pad the buffer
            const paddedBuffer = new ArrayBuffer(paddedLength);
            const view = new Uint8Array(paddedBuffer);
            view.set(new Uint8Array(audioBuffer));
            audioData = new Float32Array(paddedBuffer);
        } else {
            // Buffer already has the right size
            audioData = new Float32Array(audioBuffer);
        }
    } else if (audioBuffer.buffer && audioBuffer.buffer instanceof ArrayBuffer) {
        // It's already a typed array
        audioData = audioBuffer;
    } else {
        throw new Error('Invalid audio data format');
    }
    
    // Check if the audio data is in the correct format for the model
    if (audioData.length === 0) {
        throw new Error('Audio data is empty');
    }
    
    return audioData;
}
