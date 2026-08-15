import yaml
import os
import urllib.request
import re

YAML_FILE = "config/sources.yaml"

def get_sp500_tickers():
    try:
        url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        html = urllib.request.urlopen(req).read().decode('utf-8')
        tickers = re.findall(r'>([A-Z]{1,5})</a></td>\n<td id="[^"]*"><a rel="mw:WikiLink" href="https://en.wikipedia.org/wiki/[^"]*" title="[^"]*"', html)
        if not tickers:
            # Fallback regex just in case
            tickers = re.findall(r'href="https://(?:www\.)?(?:nyse|nasdaq|cboe)\.com/[^"]+">([A-Z]+)</a>', html)
        return list(dict.fromkeys(tickers)) # deduplicate
    except Exception as e:
        print(f"Error fetching SP500: {e}")
        return []

def get_more_liquid_tickers():
    # Top Nasdaq 100 / Russell 2000 / ETFs / Crypto not in SP500
    return [
        "SPY", "QQQ", "IWM", "DIA", "VXX", "ARKK", "TLT", "HYG", "EEM", "EFA", "GLD", "SLV", "USO", "UNG",
        "TSLA", "META", "AAPL", "MSFT", "AMZN", "NVDA", "GOOGL", "GOOG", "NFLX", "AMD", "COIN", "MARA",
        "RIOT", "MSTR", "HOOD", "PLTR", "SOFI", "RIVN", "LCID", "NIO", "XPEV", "LI", "BABA", "JD", "PDD",
        "SNOW", "CRWD", "DDOG", "NET", "MDB", "OKTA", "ZS", "U", "DKNG", "PTON", "ROKU", "AFRM", "UPST",
        "OPEN", "TOST", "GTLB", "HCP", "ASTS", "NVST", "RDDT", "DJT", "SMCI", "ARM", "ALAB", "SYM",
        "QDEL", "APP", "CVNA", "CHWY", "DKS", "LULU", "ANF", "CELH", "ELF", "CROX", "LUNR", "RKLB",
        "PLUG", "FCEL", "BLDP", "FSR", "NKLA", "QS", "CHPT", "BLNK", "EVGO", "LAZR", "VLDR", "OUST",
        "PATH", "DOCN", "ASAN", "MOND", "SMAR", "GTLB", "BILL", "NCNO", "ZI", "DLO", "MQ", "AFRM",
        "SHOP", "SQ", "PYPL", "V", "MA", "AXP", "DFS", "COF", "SYF", "ALLY", "C", "JPM", "BAC", "WFC",
        "MS", "GS", "SCHW", "IBKR", "RJF", "LPLA", "SF", "STT", "BK", "NTRS", "TROW", "AMP", "BLK",
        "CME", "ICE", "NDAQ", "CBOE", "MKTX", "TW", "VIRT", "CG", "BX", "KKR", "APO", "ARES", "OAK",
        "BMY", "PFE", "MRK", "JNJ", "ABBV", "LLY", "NVO", "SNY", "AZN", "GSK", "NVS", "ROG", "BAYRY",
        "TMO", "DHR", "A", "MTD", "WAT", "ILMN", "PKI", "BIO", "TECH", "BRKR", "CRL", "MEDP", "IQV",
        "XOM", "CVX", "COP", "EOG", "PXD", "OXY", "HES", "MPC", "VLO", "PSX", "KMI", "WMB", "OKE",
        "NEE", "DUK", "SO", "D", "AEP", "EXC", "XEL", "ED", "PEG", "WEC", "ES", "AWK", "FE", "ETR",
        "PLD", "AMT", "CCI", "EQIX", "PSA", "O", "SPG", "WELL", "VTR", "AVB", "EQR", "ESS", "MAA",
        "LMT", "RTX", "BA", "GD", "NOC", "HWM", "TXT", "LHX", "TDG", "HEI", "BWXT", "CW", "WWD",
        "CAT", "DE", "PCAR", "CMI", "DOV", "ITW", "PH", "EMR", "ROK", "IR", "PNR", "AOS", "FTV",
        "UNP", "CSX", "NSC", "ODFL", "JBHT", "KNX", "CHRW", "EXPD", "FDX", "UPS", "DAL", "UAL",
        "AAL", "LUV", "ALK", "JBLU", "HA", "SAVE", "MESA", "SNCY", "ULCC", "PLAY", "RUTH", "CAKE",
        "DRI", "TXRH", "BJRI", "BLMN", "DIN", "EAT", "PZZA", "DPZ", "WEN", "SHAK", "YUM", "MCD",
        "SBUX", "CMG", "BROS", "DUTCH", "LBRT", "NEX", "OIS", "PTEN", "HP", "DRQ", "WTTR", "CHX",
        "ABNB", "UBER", "LYFT", "DASH", "CART", "INST", "KOF", "FMX", "CCU", "AKO.B", "BUD", "TAP",
        "STZ", "SAM", "MNST", "CELH", "BRBR", "COCO", "VITL", "SMPL", "THS", "POST", "BYND", "OTLY",
        "WING", "FRG", "DENN", "RMCF", "DNUT", "SJM", "K", "GIS", "CPB", "HRL", "MKC", "CAG", "TSN",
        "PPC", "SAFM", "CALM", "FDP", "DOLE", "CVGW", "LMNR", "ALCO", "LANC", "TR", "JJSF", "JBSS",
        "SYY", "USFD", "PFGC", "CHEF", "UNFI", "SPT", "PRG", "HVT", "AAN", "RCII", "CONN", "WHR",
        "IRBT", "PTON", "HELE", "EPC", "ENR", "CL", "KMB", "EL", "COTY", "ELF", "REV", "NUS", "NATR",
        "MED", "HLF", "USNA", "NWL", "CLX", "CHD", "PG", "JNJ", "KDP", "PEP", "KO", "KHC", "MDLZ",
        "KEX", "VFC", "UAA", "NKE", "ADDYY", "ASICS", "CROX", "SKX", "SHOO", "WWW", "DECK", "ONON",
        "GOOS", "COLM", "GPS", "ANF", "URBN", "AEO", "BKE", "GCO", "HIBB", "DKS", "SPWH", "CABO",
        "SIRI", "SPOT", "LYV", "WMG", "SNE", "NTES", "BILI", "TME", "IQ", "HUYA", "DOYU", "YY",
        "MOMO", "WB", "SOHU", "CYOU", "VNET", "GDS", "KC", "KSPI", "OZON", "YNDX", "MTCH", "BMBL"
    ]

def load_yaml(filepath):
    try:
        from ruamel.yaml import YAML
        yaml = YAML()
        yaml.preserve_quotes = True
        with open(filepath, 'r') as f:
            return yaml.load(f)
    except ImportError:
        import yaml
        with open(filepath, 'r') as f:
            return yaml.safe_load(f)

def save_yaml(data, filepath):
    try:
        from ruamel.yaml import YAML
        yaml = YAML()
        yaml.preserve_quotes = True
        with open(filepath, 'w') as f:
            yaml.dump(data, f)
    except ImportError:
        import yaml
        with open(filepath, 'w') as f:
            yaml.dump(data, f, sort_keys=False)

def main():
    print(f"Loading {YAML_FILE}...")
    data = load_yaml(YAML_FILE)
    
    sources_list = data.get('sources', [])
    
    # 1. Remove all Twitter/TruthSocial sources
    original_len = len(sources_list)
    sources_list = [s for s in sources_list if isinstance(s, dict) and s.get('sourceType') not in ('x', 'truthsocial')]
    removed = original_len - len(sources_list)
    print(f"Removed {removed} Twitter/TruthSocial sources. {len(sources_list)} sources remain.")
    
    # 2. Get 750+ Tickers
    sp500 = get_sp500_tickers()
    more = get_more_liquid_tickers()
    all_tickers = list(set(sp500 + more)) # deduplicate
    print(f"Found {len(all_tickers)} unique liquid tickers.")
    
    # 3. Add Free Macro & Options Flow Sources
    free_macro = [
        {
            "id": "rss:benzinga-options",
            "name": "Benzinga Options",
            "url": "https://www.benzinga.com/markets/options/feed/",
            "org": "benzinga",
            "sourceType": "rss",
            "category": "ORDER_FLOW",
            "priority": 95,
            "enabled": True,
            "qualityScore": 90,
            "noiseScore": 15,
            "official": False,
            "notes": "Unusual options activity and block trades."
        },
        {
            "id": "rss:zerohedge",
            "name": "ZeroHedge",
            "url": "http://feeds.feedburner.com/zerohedge/feed",
            "org": "zerohedge",
            "sourceType": "rss",
            "category": "MACRO",
            "priority": 90,
            "enabled": True,
            "qualityScore": 85,
            "noiseScore": 25,
            "official": False,
            "notes": "Fast macro commentary and market chatter."
        },
        {
            "id": "rss:barchart",
            "name": "Barchart News",
            "url": "https://www.barchart.com/news/rss",
            "org": "barchart",
            "sourceType": "rss",
            "category": "ORDER_FLOW",
            "priority": 88,
            "enabled": True,
            "qualityScore": 88,
            "noiseScore": 20,
            "official": False,
            "notes": "General market flow and options updates."
        },
        {
            "id": "rss:investing-macro",
            "name": "Investing.com Macro",
            "url": "https://www.investing.com/rss/news_285.rss",
            "org": "investing",
            "sourceType": "rss",
            "category": "MACRO",
            "priority": 85,
            "enabled": True,
            "qualityScore": 92,
            "noiseScore": 10,
            "official": False,
            "notes": "Economic indicators and central bank policy."
        }
    ]
    
    # Check if they exist
    existing_ids = set(s['id'] for s in sources_list if isinstance(s, dict) and 'id' in s)
    for source in free_macro:
        if source['id'] not in existing_ids:
            sources_list.append(source)
            existing_ids.add(source['id'])
            
    # 4. Generate 1,500+ Yahoo/EDGAR feeds
    added_tickers = 0
    for ticker in all_tickers:
        yahoo_id = f"rss:yahoo-{ticker.lower()}"
        edgar_id = f"rss:sec-8k-{ticker.lower()}"
        
        if yahoo_id not in existing_ids:
            sources_list.append({
                "id": yahoo_id,
                "name": f"Yahoo Finance — {ticker}",
                "url": f"https://finance.yahoo.com/rss/headline?s={ticker}",
                "org": "yahoo",
                "sourceType": "rss",
                "category": "EQUITY",
                "priority": 80,
                "enabled": True,
                "official": False,
                "qualityScore": 88,
                "noiseScore": 25,
                "expectedIntervalMs": 86400000,
                "notes": f"Yahoo Finance breaking news for {ticker}"
            })
            existing_ids.add(yahoo_id)
            added_tickers += 1
            
        if edgar_id not in existing_ids:
            sources_list.append({
                "id": edgar_id,
                "name": f"SEC 8-K Filings — {ticker}",
                "url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={ticker}&type=8-K&output=atom",
                "org": "sec",
                "sourceType": "rss",
                "category": "EQUITY",
                "priority": 100,
                "enabled": True,
                "official": True,
                "qualityScore": 100,
                "noiseScore": 0,
                "expectedIntervalMs": 2592000000,
                "notes": f"Material events and filings for {ticker}"
            })
            existing_ids.add(edgar_id)
            added_tickers += 1
            
    print(f"Added {added_tickers} new ticker-specific RSS sources.")
    print(f"Total sources now at: {len(sources_list)}")
    
    data['sources'] = sources_list
    save_yaml(data, YAML_FILE)
    print("Saved to config/sources.yaml successfully.")

if __name__ == "__main__":
    main()
