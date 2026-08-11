const text = "OPENBB BOT:** <T:1786433659:T> - **BRENT, US CRUDE FUTURES GAIN OVER 2%, HIGHEST LEVEL SINCE JULY 31** \\n\\n⚡ Sent via Icarus | Arbor Capital — For information and data display only. Trade at your own risk.";
const headerMatch = /^\s*\*{0,2}([a-zA-Z0-9_\s]{1,60}):?\*{0,2}\s*(?:<t:\d+:t>)?\s*[-—:]\s+/im.exec(text);
console.log("headerMatch:", headerMatch ? headerMatch[0] : "null");

const footerRegex = /(?:_\*\s*)?(?:⚡\s*)?SENT VIA ICARUS[\s\S]*?Trade at your own risk\.?(?:\*_)?/gi;
const strippedFooter = text.replace(footerRegex, '').trim();
console.log("strippedFooter:", strippedFooter);
