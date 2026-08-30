export function normalizeSttHotwords(value) {
  return Array.from(
    new Set(
      String(value || '')
        .replace(/[\r\n]+/g, ' ')
        .split(/[\s,，;；]+/)
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ).join(' ')
}

export function getSttHotwordFlag(backend) {
  if (backend === 'paraformer') return '--paraformer_stt_gen_hotword'
  if (backend === 'fun-asr-nano') return '--fun_asr_nano_stt_gen_hotword'
  return null
}
