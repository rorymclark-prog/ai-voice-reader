export function pickDeviceVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const allowed = voices.filter(voice =>
    !/(?:^|[^a-z])tessa(?:$|[^a-z])/i.test(`${voice.name} ${voice.voiceURI}`)
  );
  const english = allowed.filter(voice => /^en(?:[-_]|$)/i.test(voice.lang));
  return english.find(voice => /natural|enhanced|premium|samantha|siri/i.test(voice.name))
    ?? english[0] ?? allowed[0] ?? null;
}
