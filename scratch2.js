const TEXT_HEADERS = [
  // unusual_whales_crier:** headline
  { re: /^\s*([A-Za-z0-9_.-]{2,60})\s*:\*{2}\s+(?=\S)/i, author: 1, channel: null },
];

function parseTextHeader(content) {
  if (!content) return null;
  for (const pattern of TEXT_HEADERS) {
    const match = pattern.re.exec(content);
    if (!match) continue;
    const author = match[pattern.author].trim();
    if (!author) continue;
    const channel = pattern.channel === null ? null : match[pattern.channel].trim();
    const rest = content.slice(match[0].length).trim();
    if (!rest) continue;
    return { author, channel, rest };
  }
  return null;
}

const tests = [
  "unusual_whales_crier:** Twitter post link: ↩ [ (@JWSPEED2)]( ) [@JWSPEED2]( ) waiting on ebay to return me my buy",
  "UNUSUAL_WHALES_CRIER:** TWITTER POST LINK: ↩ [ (@JWSPEED2)]( ) [@JWSPEED2]( ) WAITING ON EBAY TO RETURN ME MY BUY"
];

for (let text of tests) {
  console.log("TEST:", text);
  console.log("RESULT:", parseTextHeader(text));
}
