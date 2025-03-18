// transcriptionManager.js
import MyWorker from './transcriberWorker?worker'
class ParallelTranscriptionManager {
    constructor(modelPath, language, numWorkers = null) {
      this.modelPath = modelPath;
      this.language = language;
      this.numWorkers = 2;
      this.workers = [];
      this.results = [];
      this.completedChunks = 0;
      this.totalChunks = 0;
      this.onProgressCallback = null;
      this.onCompleteCallback = null;
      this.onErrorCallback = null;
    }
  
    initialize() {
      // Create workers
      for (let i = 0; i < this.numWorkers; i++) {
        const worker = new MyWorker(
            new URL('./transcriberWorker.js', import.meta.url).href, 
            { type: 'module' }
          );
        
        worker.onmessage = (event) => {
          const { type, chunkIndex, progress, subtitles, message, value } = event.data;
          
          switch (type) {
            case 'chunkComplete':
              this.results[chunkIndex] = subtitles;
              this.completedChunks++;
              
              if (this.onProgressCallback) {
                this.onProgressCallback(
                  Math.round((this.completedChunks / this.totalChunks) * 100),
                  `Processed ${this.completedChunks} of ${this.totalChunks} chunks`
                );
              }
              
              // Check if all chunks are processed
              if (this.completedChunks === this.totalChunks) {
                this.finalizeResults();
              } else {
                // Process next chunk from the queue if available
                this.processNextChunkFromQueue(worker, i);
              }
              break;
              
            case 'progress':
              // Handle individual worker progress
              if (this.onProgressCallback) {
                this.onProgressCallback(value, `Worker ${i + 1}: ${message}`);
              }
              break;
              
            case 'log':
              console.log(`Worker ${i + 1}: ${message}`);
              break;
              
            case 'error':
              console.error(`Worker ${i + 1} error: ${message}`);
              if (this.onErrorCallback) {
                this.onErrorCallback(message);
              }
              break;
          }
        };
        
        worker.onerror = (error) => {
          console.error(`Worker ${i + 1} error:`, error);
          if (this.onErrorCallback) {
            this.onErrorCallback(error.message);
          }
        };
        
        this.workers.push({
          worker,
          busy: false,
          id: i
        });
      }
      
      return this;
    }
  
    // Method to transcribe audio
    async transcribe(audioBuffer, sampleRate = 16000) {
      this.results = [];
      this.completedChunks = 0;
      this.chunkQueue = [];
      
      // Split audio into chunks
      const chunks = this.splitAudioIntoChunks(audioBuffer, sampleRate);
      this.totalChunks = chunks.length;
      this.results = new Array(this.totalChunks);
      
      if (this.onProgressCallback) {
        this.onProgressCallback(0, `Starting transcription with ${this.numWorkers} workers for ${this.totalChunks} chunks`);
      }
      
      // Create a queue of chunks to process
      this.chunkQueue = chunks.map((chunk, index) => ({
        audioBuffer: chunk,
        chunkIndex: index
      }));
      
      // Start processing with available workers
      this.workers.forEach(workerInfo => {
        this.processNextChunkFromQueue(workerInfo.worker, workerInfo.id);
      });
      
      // Return a promise that resolves when all chunks are processed
      return new Promise((resolve, reject) => {
        this.onCompleteCallback = resolve;
        this.onErrorCallback = (error) => reject(new Error(error));
      });
    }
  
    // Process the next chunk from the queue
    processNextChunkFromQueue(worker, workerId) {
      if (this.chunkQueue.length === 0) {
        // No more chunks to process
        return;
      }
      
      const { audioBuffer, chunkIndex } = this.chunkQueue.shift();
      
      // Mark worker as busy
      const workerInfo = this.workers.find(w => w.id === workerId);
      if (workerInfo) {
        workerInfo.busy = true;
      }
      
      // Send chunk to worker
      worker.postMessage({
        type: 'chunk',
        modelPath: this.modelPath,
        audioBuffer: audioBuffer,
        language: this.language,
        chunkIndex: chunkIndex,
        totalChunks: this.totalChunks
      });
    }
  
    // Finalize results from all workers
    finalizeResults() {
      // Combine results from all chunks
      const flattenedResults = [];
      let idCounter = 1;
      
      this.results.forEach(chunkResults => {
        if (chunkResults && chunkResults.length) {
          // Adjust IDs to ensure they're sequential
          const adjustedResults = chunkResults.map(subtitle => ({
            ...subtitle,
            id: idCounter++
          }));
          
          flattenedResults.push(...adjustedResults);
        }
      });
      
      // Sort by start time
      flattenedResults.sort((a, b) => a.start - b.start);
      
      // Merge overlapping subtitles
      const mergedResults = this.mergeOverlappingSubtitles(flattenedResults);
      
      if (this.onCompleteCallback) {
        this.onCompleteCallback(mergedResults);
      }
    }
  
    // Helper method to split audio into chunks
    splitAudioIntoChunks(audioBuffer, sampleRate) {
      // Calculate chunk size - 30 seconds of audio at the given sample rate
      const chunkDuration = 30; // seconds
      const samplesPerChunk = chunkDuration * sampleRate;
      const totalChunks = Math.ceil(audioBuffer.length / samplesPerChunk);
      const chunks = [];
      
      for (let i = 0; i < totalChunks; i++) {
        const start = i * samplesPerChunk;
        const end = Math.min(start + samplesPerChunk, audioBuffer.length);
        const chunkBuffer = audioBuffer.slice(start, end);
        chunks.push(chunkBuffer);
      }
      
      return chunks;
    }
  
    // Helper method to merge overlapping subtitles
    mergeOverlappingSubtitles(subtitles) {
      if (!subtitles || subtitles.length <= 1) return subtitles;
      
      const merged = [];
      let current = subtitles[0];
      
      for (let i = 1; i < subtitles.length; i++) {
        const next = subtitles[i];
        
        // If current and next overlap
        if (next.start <= current.end + 0.5) { // Allow 0.5 second overlap
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
      
      // Reassign IDs
      return merged.map((item, index) => ({
        ...item,
        id: index + 1
      }));
    }
  
    // Set progress callback
    onProgress(callback) {
      this.onProgressCallback = callback;
      return this;
    }
  
    // Terminate all workers
    terminate() {
      this.workers.forEach(workerInfo => {
        workerInfo.worker.terminate();
      });
      this.workers = [];
    }
  }
  
  // Export the manager
  export default ParallelTranscriptionManager;