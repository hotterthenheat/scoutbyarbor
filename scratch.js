const tests = [
  "unusual_whales_crier:** Twitter post link: ↩ [ (@JWSPEED2)]( ) [@JWSPEED2]( ) waiting on ebay to return me my buy history from the last few years so i can use this as a way to find my cost basis **[❤️]( ) 1 71 ** _* *_"
];

for (let text of tests) {
  let cleaned = text.replace(/unusual_whales_crier:\*\*/i, '');
  cleaned = cleaned.replace(/Twitter post link:\s*↩\s*(?:\[\s*\(@[a-zA-Z0-9_]+\)\s*\]\(\s*\)\s*)?(?:\[@[a-zA-Z0-9_]+\]\(\s*\)\s*)?/gi, '');
  cleaned = cleaned.replace(/\*\*\[.*?\]\(\s*\).*?\*\*\s*_\*\s*\*_\s*$/g, '');
  console.log("CLEANED:", cleaned.trim());
}
