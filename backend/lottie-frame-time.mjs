// Map seconds onto the export's rounded frame clock, including its final boundary.
export function lottieFramePosition(times, time) {
  let low = 0, high = times.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time) low = middle;
    else high = middle;
  }
  return low + (time - times[low]) / (times[high] - times[low]);
}
