YAML_FILE = "config/sources.yaml"

new_sources = [
    {
        "id": "rss:reuters-world",
        "name": "Reuters — World News",
        "url": "https://www.reutersagency.com/feed/?best-topics=world-news&post_type=best",
        "org": "reuters",
        "sourceType": "rss",
        "category": "GEOPOLITICAL",
        "priority": 90,
        "enabled": True,
        "official": False,
        "qualityScore": 95,
        "noiseScore": 10,
        "macroScore": 40,
        "microScore": 5,
        "geopoliticalScore": 100,
        "expectedIntervalMs": 3600000
    },
    {
        "id": "rss:aljazeera-middleeast",
        "name": "Al Jazeera — Middle East",
        "url": "https://www.aljazeera.com/xml/rss/all.xml",
        "org": "aljazeera",
        "sourceType": "rss",
        "category": "GEOPOLITICAL",
        "priority": 85,
        "enabled": True,
        "official": False,
        "qualityScore": 85,
        "noiseScore": 15,
        "macroScore": 10,
        "microScore": 5,
        "geopoliticalScore": 100,
        "expectedIntervalMs": 3600000
    },
    {
        "id": "rss:defensenews",
        "name": "DefenseNews",
        "url": "https://www.defensenews.com/arc/outboundfeeds/rss/",
        "org": "defensenews",
        "sourceType": "rss",
        "category": "GEOPOLITICAL",
        "priority": 80,
        "enabled": True,
        "official": False,
        "qualityScore": 90,
        "noiseScore": 5,
        "macroScore": 20,
        "microScore": 10,
        "geopoliticalScore": 95,
        "expectedIntervalMs": 7200000
    },
    {
        "id": "rss:politico",
        "name": "Politico — Top Stories",
        "url": "https://rss.politico.com/politics-news.xml",
        "org": "politico",
        "sourceType": "rss",
        "category": "POLITICS",
        "priority": 90,
        "enabled": True,
        "official": False,
        "qualityScore": 90,
        "noiseScore": 15,
        "macroScore": 40,
        "microScore": 5,
        "geopoliticalScore": 20,
        "expectedIntervalMs": 3600000
    },
    {
        "id": "rss:thehill",
        "name": "The Hill — News",
        "url": "https://thehill.com/feed/",
        "org": "thehill",
        "sourceType": "rss",
        "category": "POLITICS",
        "priority": 85,
        "enabled": True,
        "official": False,
        "qualityScore": 85,
        "noiseScore": 20,
        "macroScore": 30,
        "microScore": 5,
        "geopoliticalScore": 15,
        "expectedIntervalMs": 3600000
    },
    {
        "id": "rss:zerohedge",
        "name": "ZeroHedge",
        "url": "https://feeds.feedburner.com/zerohedge/feed",
        "org": "zerohedge",
        "sourceType": "rss",
        "category": "MARKET",
        "priority": 85,
        "enabled": True,
        "official": False,
        "qualityScore": 75,
        "noiseScore": 30,
        "macroScore": 80,
        "microScore": 60,
        "geopoliticalScore": 60,
        "expectedIntervalMs": 3600000
    },
    {
        "id": "rss:benzinga-news",
        "name": "Benzinga — Market News",
        "url": "https://www.benzinga.com/feed",
        "org": "benzinga",
        "sourceType": "rss",
        "category": "MARKET",
        "priority": 95,
        "enabled": True,
        "official": False,
        "qualityScore": 95,
        "noiseScore": 10,
        "macroScore": 70,
        "microScore": 85,
        "geopoliticalScore": 10,
        "expectedIntervalMs": 1800000
    }
]

with open(YAML_FILE, "a") as f:
    f.write("\n  # " + "="*74 + "\n")
    f.write("  # DEEP DIVE FEEDS (GEOPOLITICS, POLITICS, ORDER FLOW)\n")
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
    official: false
    qualityScore: {feed['qualityScore']}
    noiseScore: {feed['noiseScore']}
    macroScore: {feed['macroScore']}
    microScore: {feed['microScore']}
    geopoliticalScore: {feed['geopoliticalScore']}
    expectedIntervalMs: {feed['expectedIntervalMs']}
""")

print("Successfully added deep dive sources.")
