import { completedBars } from './setup-policy.mjs';

export function bufferedInvalidationBoundary(bars, optionType, now = new Date()) {
  const completed = completedBars(bars, 60000, now);
  const ranges = completed.map(b => Number(b.high_price) - Number(b.low_price)).sort((a, b) => a - b);
  const medianRange = (ranges[4] + ranges[5]) / 2;
  const buffer = Math.min(0.25, Math.max(0.08, medianRange / 2));
  const swing = optionType === 'put'
    ? Math.max(...completed.map(b => Number(b.high_price)))
    : Math.min(...completed.map(b => Number(b.low_price)));
  return { boundary: optionType === 'put' ? swing + buffer : swing - buffer,
    swing, buffer, median_range: medianRange };
}

export function requireBufferedInvalidation(level, optionType, boundary) {
  if (optionType === 'put' && level < boundary) throw new Error('Put invalidation is inside recent QQQ noise');
  if (optionType === 'call' && level > boundary) throw new Error('Call invalidation is inside recent QQQ noise');
}
