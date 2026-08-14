YAML_FILE = "config/sources.yaml"

new_sources = [
    # CRYPTO
    {
        "id": "rss:coindesk",
        "name": "CoinDesk",
        "url": "https://www.coindesk.com/arc/outboundfeeds/rss/",
        "org": "coindesk",
        "category": "CRYPTO",
        "priority": 85,
        "qualityScore": 90,
        "noiseScore": 20,
        "macroScore": 40,
        "microScore": 90,
        "geopoliticalScore": 10,
        "expectedIntervalMs": 3600000
    },
    {
        "id": "rss:cointelegraph",
        "name": "CoinTelegraph",
        "url": "https://cointelegraph.com/rss",
        "org": "cointelegraph",
        "category": "CRYPTO",
        "priority": 80,
        "qualityScore": 85,
        "noiseScore": 25,
        "macroScore": 30,
        "microScore": 85,
        "geopoliticalScore": 5,
        "expectedIntervalMs": 3600000
    },
    # BIOTECH & HEALTHCARE
    {
        "id": "rss:fda-recalls",
        "name": "FDA Recalls & Safety Alerts",
        "url": "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml",
        "org": "fda",
        "category": "EQUITY",
        "priority": 95,
        "qualityScore": 100,
        "noiseScore": 5,
        "macroScore": 10,
        "microScore": 95,
        "geopoliticalScore": 5,
        "expectedIntervalMs": 14400000
    },
    {
        "id": "rss:fda-press",
        "name": "FDA Press Releases",
        "url": "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml",
        "org": "fda",
        "category": "EQUITY",
        "priority": 90,
        "qualityScore": 100,
        "noiseScore": 5,
        "macroScore": 20,
        "microScore": 90,
        "geopoliticalScore": 10,
        "expectedIntervalMs": 14400000
    },
    # COMMODITIES / ENERGY
    {
        "id": "rss:oilprice",
        "name": "OilPrice.com",
        "url": "https://oilprice.com/rss/main",
        "org": "oilprice",
        "category": "COMMODITY",
        "priority": 85,
        "qualityScore": 85,
        "noiseScore": 30,
        "macroScore": 60,
        "microScore": 30,
        "geopoliticalScore": 70,
        "expectedIntervalMs": 7200000
    },
    # EUROPEAN MACRO
    {
        "id": "rss:ft-markets",
        "name": "Financial Times - Markets",
        "url": "https://www.ft.com/markets?format=rss",
        "org": "ft",
        "category": "MARKET",
        "priority": 90,
        "qualityScore": 95,
        "noiseScore": 15,
        "macroScore": 80,
        "microScore": 50,
        "geopoliticalScore": 50,
        "expectedIntervalMs": 3600000
    }
]

with open(YAML_FILE, "a") as f:
    f.write("\n  # " + "="*74 + "\n")
    f.write("  # ALTERNATIVE DATA & SECTOR SPECIFIC (CRYPTO, BIOTECH, COMMODITIES)\n")
    f.write("  # " + "="*74 + "\n")
    
    for feed in new_sources:
        f.write(f"""  - id: {feed['id']}
    name: {feed['name']}
    url: {feed['url']}
    org: {feed['org']}
    sourceType: rss
    category: {feed['category']}
    priority: {feed['priority']}
    enabled: true
    official: {str(feed['org'] == 'fda').lower()}
    qualityScore: {feed['qualityScore']}
    noiseScore: {feed['noiseScore']}
    macroScore: {feed['macroScore']}
    microScore: {feed['microScore']}
    geopoliticalScore: {feed['geopoliticalScore']}
    expectedIntervalMs: {feed['expectedIntervalMs']}
""")

print("Successfully added alternative data sources.")
