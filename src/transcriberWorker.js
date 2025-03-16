// transcriberWorker.js

import { pipeline } from "@huggingface/transformers";

self.onmessage = async function (event) {
    const { modelPath, audioBuffer, language } = event.data;
    console.log(modelPath);
    
    try {
        self.postMessage({ type: 'log', message: `Starting to load model: ${modelPath}` });
        
        // Add more detailed progress reporting
        let lastProgress = 0;
        const transcriber = await pipeline('automatic-speech-recognition', modelPath, {
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
        
        // Check if audio data is valid
        if (!audioBuffer || audioBuffer.length === 0) {
            throw new Error('Invalid audio data received');
        }
        
        self.postMessage({ type: 'log', message: 'Starting transcription...' });

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
        console.log(audioData);
        
        // Check if the audio data is in the correct format for the model
        if (audioData.length === 0) {
            throw new Error('Audio data is empty');
        }

        self.postMessage({ type: 'log', message: 'Audio extracted. Processing transcription...' });

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

        // Process the result and send back the subtitles
        let subtitles;
        if (result && result.chunks) {
            subtitles = result.chunks.map((chunk, index) => ({
                id: index + 1,
                start: chunk.timestamp[0],
                end: chunk.timestamp[1],
                text: chunk.text.trim()
            }));
        } else if (result && result.text) {
            // If no chunks are returned, use the whole text
            subtitles = [{
                id: 1,
                start: 0,
                end: audioData.length / 16000, // Assuming 16kHz sample rate
                text: result.text.trim()
            }];
        } else {
            throw new Error('Invalid transcription result');
        }

        self.postMessage({ type: 'result', subtitles });

    } catch (error) {
        self.postMessage({ type: 'error', message: `Worker error: ${error.message}` });
        console.error('Worker error:', error);
    }
};
