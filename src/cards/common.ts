export function formatDateTime24h(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
}
