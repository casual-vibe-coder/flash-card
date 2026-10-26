// Client request lifecycle. Generation is only started by an explicit user action.
export class TranscriptError extends Error {
  constructor(data = {}) {
    super(data.message || data.detail || data.error || 'Transcript unavailable.');
    this.name = 'TranscriptError';this.code = data.error || 'transcript_unavailable';
    this.canGenerate = data.canGenerate !== false;this.pendingJob = data.jobId || null;
  }
}
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
  const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});
export async function requestTranscript(videoId, { generate = false, jobId = null, signal, onJob = () => {}, onStatus = () => {}, fetcher = fetch, sleep = pause, maxPolls = 120 } = {}) {
  let job = jobId;
  for (let attempt = 0; attempt <= maxPolls; attempt++) {
    const params = new URLSearchParams({ v: videoId });
    if (job) params.set('job', job); else if (generate) params.set('generate', '1');
    const response = await fetcher('/api/yt-transcript?' + params, { signal });
    const data = await response.json().catch(() => ({ error: 'unreadable_response', message: 'The transcript service returned an unreadable response.' }));
    if (!response.ok || data.error) throw new TranscriptError(data);
    if (data.lines?.length) return data;
    if (!data.pending || !data.jobId) throw new TranscriptError({ error: 'empty_transcript', message: 'No transcript was returned.', canGenerate: !generate });
    job = data.jobId;onJob(job);onStatus('Speech-to-text is processing. You can leave and resume this job without starting another.');
    if (attempt === maxPolls) throw new TranscriptError({ error: 'still_processing', jobId: job, message: 'This transcript is still processing. Resume it to check again without starting another job.' });
    await sleep(3000, signal);
  }
}
