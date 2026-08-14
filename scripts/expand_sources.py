import os

TICKERS = [
    "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "GOOG", "BRK.B", "LLY", "TSLA",
    "AVGO", "JPM", "UNH", "V", "XOM", "MA", "JNJ", "PG", "HD", "COST",
    "MRK", "ABBV", "CVX", "CRM", "AMD", "NFLX", "PEP", "KO", "ADBE", "TMO",
    "WMT", "BAC", "ACN", "LIN", "MCD", "CSCO", "ABT", "INTU", "QCOM", "WFC",
    "DHR", "INTC", "CMCSA", "VZ", "TXN", "PFE", "AMAT", "NOW", "COP", "IBM",
    "UNP", "PM", "SPGI", "BA", "HON", "AMGN", "GE", "NEE", "SYK", "LOW",
    "CAT", "RTX", "GS", "ISRG", "ELV", "T", "PLD", "MDT", "AXP", "BLK",
    "VRTX", "BKNG", "TJX", "SBUX", "C", "LRCX", "REGN", "MDLZ", "CB", "MMC",
    "GILD", "ADI", "ADP", "PGR", "CVS", "ZTS", "BSX", "CI", "MU", "SCHW",
    "FI", "BMY", "EOG", "KLAC", "SNPS", "CME", "CDNS", "SO", "DE", "DUK",
    "SHW", "WM", "CSX", "ITW", "MO", "MCK", "ICE", "BDX", "AON", "NOC",
    "APD", "PH", "MCO", "ECL", "APH", "TGT", "USB", "NXPI", "ROP", "SLB",
    "ORLY", "PSX", "TDG", "FCX", "RSG", "PNC", "MAR", "EMR", "NSC", "PCAR",
    "AEP", "VLO", "O", "MMM", "GD", "AZO", "LMT", "MPC", "DXCM", "FDX",
    "SRE", "TRV", "EW", "GPN", "AJG", "D", "KMB", "MSI", "OXY", "WMB",
    "PAYX", "COF", "MCHP", "HLT", "NEM", "HUM", "EXC", "ROST", "CTAS", "AIG",
    "MNST", "TEL", "IQV", "AFL", "KMI", "DOW", "CNC", "A", "CCI", "SYY",
    "MET", "PRU", "CTSH", "NUE", "IDXX", "YUM", "JCI", "STZ", "SPG", "ALL",
    "ED", "AMP", "MS", "BIIB", "TRMB", "OTIS", "VRSK", "SNA", "FTV", "K",
    "BKR", "DOV", "PPG", "PEG", "IFF", "AWK", "XYL", "DLTR", "ROK", "WBA",
    "KDP", "TSCO", "CTVA", "CARR", "EIX", "ALB", "FAST", "CPRT", "LVS", "F",
    "GM", "HAL", "MRO", "DAL", "UAL", "AAL", "LUV", "NKE", "EBAY", "PYPL",
    "UBER", "LYFT", "SNOW", "PLTR", "HOOD", "COIN", "RBLX", "SQ", "SHOP", "ZM",
    "DOCU", "CRWD", "DDOG", "NET", "MDB", "OKTA", "ZS", "U", "DKNG", "PTON",
    "ROKU", "AFRM", "UPST", "OPEN", "LCID", "RIVN", "SOFI", "TOST", "GTLB", "HCP",
    "ASTS", "NVST", "RDDT", "DJT", "MSTR", "SMCI", "ARM", "ALAB", "SYM", "ASTS",
    "QDEL", "APP", "CVNA", "CHWY", "DKS", "LULU", "ANF", "CELH", "ELF", "CROX"
]

YAML_FILE = "config/sources.yaml"

with open(YAML_FILE, "a") as f:
    f.write("\n  # " + "="*74 + "\n")
    f.write("  # AUTO-GENERATED TICKER FEEDS (YAHOO FINANCE & SEC EDGAR)\n")
    f.write("  # " + "="*74 + "\n")
    
    for ticker in set(TICKERS):
        # Yahoo Finance
        f.write(f"""  - id: rss:yahoo-{ticker.lower()}
    name: Yahoo Finance — {ticker}
    url: https://finance.yahoo.com/rss/headline?s={ticker}
    org: yahoo
    sourceType: rss
    category: EQUITY
    priority: 85
    enabled: true
    official: false
    qualityScore: 90
    noiseScore: 30
    macroScore: 10
    microScore: 90
    geopoliticalScore: 0
    expectedIntervalMs: 86400000
    notes: "Yahoo Finance breaking news for {ticker}"
""")
        
        # SEC EDGAR 8-K
        f.write(f"""  - id: rss:sec-8k-{ticker.lower()}
    name: SEC 8-K Filings — {ticker}
    url: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={ticker}&type=8-K&output=atom
    org: sec
    sourceType: rss
    category: EQUITY
    priority: 100
    enabled: true
    official: true
    qualityScore: 100
    noiseScore: 0
    macroScore: 5
    microScore: 100
    geopoliticalScore: 0
    expectedIntervalMs: 2592000000
    notes: "Material events and filings for {ticker}"
""")
    
    # Also add a few PR Newswire / GlobeNewswire sector feeds
    wire_feeds = [
        {"id": "rss:prn-tech", "name": "PR Newswire — Technology", "url": "https://www.prnewswire.com/rss/technology-news/latest-news.rss", "category": "EQUITY"},
        {"id": "rss:prn-health", "name": "PR Newswire — Health", "url": "https://www.prnewswire.com/rss/health-latest-news/health-latest-news-list.rss", "category": "EQUITY"},
        {"id": "rss:prn-finance", "name": "PR Newswire — Financial Services", "url": "https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss", "category": "MARKET"},
        {"id": "rss:globe-ma", "name": "GlobeNewswire — Mergers & Acquisitions", "url": "https://www.globenewswire.com/RssFeed/subjectcode/32-Mergers%20and%20Acquisitions/feedTitle/GlobeNewswire%20-%20Mergers%20and%20Acquisitions", "category": "EQUITY"}
    ]
    
    f.write("\n  # " + "="*74 + "\n")
    f.write("  # ADDITIONAL WIRE SERVICES\n")
    f.write("  # " + "="*74 + "\n")
    
    for feed in wire_feeds:
        f.write(f"""  - id: {feed['id']}
    name: {feed['name']}
    url: {feed['url']}
    org: newswire
    sourceType: rss
    category: {feed['category']}
    priority: 95
    enabled: true
    official: true
    qualityScore: 95
    noiseScore: 10
    macroScore: 20
    microScore: 85
    geopoliticalScore: 0
    expectedIntervalMs: 86400000
""")

print(f"Appended {len(set(TICKERS)) * 2 + len(wire_feeds)} sources to {YAML_FILE}")
