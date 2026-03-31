#!/usr/bin/env python3
"""
deckbldr.py — Standalone MTG Card Price Checker (Canadian Storefronts)
=======================================================================
Usage:
  python3 deckbldr.py <decklist_file> [options]

Arguments:
  input_file           Path to a .txt or .csv decklist file

Options:
  --output  OUTPUT     Output CSV path (default: prices_<timestamp>.csv)
  --condition COND     Preferred condition: NM, LP, MP (default: NM)
  --delay   MS         Delay between API requests in ms (default: 1500)
  --no-confirm         Skip the confirmation prompt and run immediately

Supported input formats:
  .txt  — One card per line, optional leading quantity  (e.g. "1 Sol Ring")
  .csv  — First column is card name, or column named "card_name"

Supported stores (Canadian, prices in CAD):
  • 401 Games        (store.401games.ca)
  • Face to Face     (facetofacegames.com)
  • Wizards Tower    (kanatacg.com)

All API configuration is embedded in this file — no external YAML needed.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.WARNING, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Embedded API Configuration
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class StoreConfig:
    name: str
    base_url: str
    currency: str
    suggest_endpoint: str          # Shopify /search/suggest.json
    suggest_params: dict           # Query params (use {card_name} placeholder)
    results_path: list[str]        # JSON path to product list
    price_field: str               # Field name for price in suggest results
    available_field: str           # Field name for availability
    url_field: str                 # Field name for product URL slug
    url_prefix: str                # Prefix for building full product URL
    variant_endpoint: str          # Shopify /products/{handle}.json
    handle_field: str = "handle"   # Field in suggest result holding the handle
    filter_field: Optional[str] = None       # Product field to filter on
    filter_value: Optional[str] = None       # Required value for that field
    filter_mode: str = "contains"  # "contains" or "equals"
    suggest_limit: int = 10


STORES: list[StoreConfig] = [
    # ── 401 Games ─────────────────────────────────────────────────────────────
    StoreConfig(
        name="401 Games",
        base_url="https://store.401games.ca",
        currency="CAD",
        suggest_endpoint="https://store.401games.ca/search/suggest.json",
        suggest_params={
            "q": "{card_name}",
            "resources[type]": "product",
            "resources[limit]": "10",
        },
        results_path=["resources", "results", "products"],
        price_field="price_min",
        available_field="available",
        url_field="url",
        url_prefix="https://store.401games.ca",
        variant_endpoint="https://store.401games.ca/products/{handle}.json",
        filter_field="type",
        filter_value="Magic",
        filter_mode="contains",
    ),

    # ── Face to Face Games ────────────────────────────────────────────────────
    StoreConfig(
        name="Face to Face",
        base_url="https://www.facetofacegames.com",
        currency="CAD",
        suggest_endpoint="https://www.facetofacegames.com/search/suggest.json",
        suggest_params={
            "q": "{card_name}",
            "resources[type]": "product",
            "resources[limit]": "10",
        },
        results_path=["resources", "results", "products"],
        price_field="price_min",
        available_field="available",
        url_field="url",
        url_prefix="https://www.facetofacegames.com",
        variant_endpoint="https://www.facetofacegames.com/products/{handle}.json",
        filter_field="vendor",
        filter_value="Magic",
        filter_mode="equals",
    ),

    # ── Wizards Tower (KanataCG) ──────────────────────────────────────────────
    StoreConfig(
        name="Wizards Tower",
        base_url="https://www.kanatacg.com",
        currency="CAD",
        suggest_endpoint="https://www.kanatacg.com/search/suggest.json",
        suggest_params={
            "q": "{card_name}",
            "resources[type]": "product",
            "resources[limit]": "10",
        },
        results_path=["resources", "results", "products"],
        price_field="price_min",
        available_field="available",
        url_field="url",
        url_prefix="https://www.kanatacg.com",
        variant_endpoint="https://www.kanatacg.com/products/{handle}.json",
        filter_field="type",
        filter_value="Magic",
        filter_mode="contains",
    ),
]

# Condition keyword maps (checked against Shopify variant option1/option2/title)
CONDITION_MAP: dict[str, list[str]] = {
    "NM":  ["NM", "NEAR MINT", "MINT"],
    "LP":  ["LP", "LIGHTLY PLAYED", "SP", "SLIGHTLY PLAYED"],
    "MP":  ["MP", "MODERATELY PLAYED", "PL", "PLAYED"],
    "HP":  ["HP", "HEAVILY PLAYED"],
    "DMG": ["DMG", "DAMAGED", "POOR"],
}

HEADERS = {"User-Agent": "Mozilla/5.0 (DeckBldr Price Checker/1.0)"}


# ─────────────────────────────────────────────────────────────────────────────
# File Parsing
# ─────────────────────────────────────────────────────────────────────────────

def parse_file(path: str) -> list[str]:
    """
    Parse a .txt or .csv decklist into a list of card names.

    .txt format:
        Lines like "1 Sol Ring", "1x Sol Ring", or just "Sol Ring".
        Lines starting with # or // are treated as comments and skipped.

    .csv format:
        First column is assumed to be the card name.
        If a header row has a column named 'card_name', that column is used.
        The header row itself is automatically skipped.
    """
    path_lower = path.lower()

    if path_lower.endswith(".csv"):
        return _parse_csv(path)
    else:
        return _parse_txt(path)


def _parse_txt(path: str) -> list[str]:
    cards: list[str] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("//"):
                    continue
                # Strip leading quantity: "1 Sol Ring" or "1x Sol Ring"
                match = re.match(r"^(\d+x?\s+)?(.+)$", line)
                if match:
                    name = match.group(2).strip()
                    if name:
                        cards.append(name)
    except FileNotFoundError:
        print(f"\n[ERROR] File not found: {path}", file=sys.stderr)
        sys.exit(1)
    return cards


def _parse_csv(path: str) -> list[str]:
    cards: list[str] = []
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            reader = csv.reader(f)
            rows = list(reader)

        if not rows:
            return []

        # Check if the first row is a header
        first = [h.strip().lower() for h in rows[0]]
        if "card_name" in first:
            col_idx = first.index("card_name")
            data_rows = rows[1:]
        else:
            col_idx = 0
            # If first row looks like a header (non-numeric first cell), skip it
            candidate = rows[0][0].strip() if rows[0] else ""
            data_rows = rows[1:] if not re.match(r"^\d+x?$", candidate) and not _looks_like_card(candidate) else rows

        for row in data_rows:
            if row and col_idx < len(row):
                name = row[col_idx].strip()
                if name and not name.startswith("#"):
                    cards.append(name)
    except FileNotFoundError:
        print(f"\n[ERROR] File not found: {path}", file=sys.stderr)
        sys.exit(1)
    except csv.Error as e:
        print(f"\n[ERROR] CSV parse error: {e}", file=sys.stderr)
        sys.exit(1)
    return cards


def _looks_like_card(text: str) -> bool:
    """Heuristic: does this string look like a card name vs a header label?"""
    non_card_words = {"card_name", "card", "name", "qty", "quantity", "count"}
    return text.lower() not in non_card_words


# ─────────────────────────────────────────────────────────────────────────────
# Card Preview
# ─────────────────────────────────────────────────────────────────────────────

def preview_cards(cards: list[str]) -> None:
    """Print a formatted preview table of parsed card names."""
    if not cards:
        print("No cards found.")
        return

    max_name_len = max(len(c) for c in cards)
    col_width = max(max_name_len, len("Card Name"))
    idx_width = max(len(str(len(cards))), 2)

    separator = f"├{'─' * (idx_width + 2)}┼{'─' * (col_width + 2)}┤"
    top        = f"┌{'─' * (idx_width + 2)}┬{'─' * (col_width + 2)}┐"
    bottom     = f"└{'─' * (idx_width + 2)}┴{'─' * (col_width + 2)}┘"
    header     = f"│ {'#'.rjust(idx_width)} │ {'Card Name'.ljust(col_width)} │"

    print()
    print(top)
    print(header)
    print(separator)
    for i, card in enumerate(cards, 1):
        print(f"│ {str(i).rjust(idx_width)} │ {card.ljust(col_width)} │")
    print(bottom)
    print(f"\n  {len(cards)} card(s) loaded.\n")


# ─────────────────────────────────────────────────────────────────────────────
# API Fetching
# ─────────────────────────────────────────────────────────────────────────────

def _get(url: str, timeout: int = 10) -> dict | list | None:
    """Simple GET request returning parsed JSON, or None on failure."""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        logger.debug(f"GET {url} failed: {e}")
    return None


def _navigate(data: dict | list, path: list[str]) -> list:
    """Walk a nested dict by a key path, returning a list."""
    node = data
    for key in path:
        if isinstance(node, dict):
            node = node.get(key, [])
        else:
            return []
    return node if isinstance(node, list) else []


def _matches_filter(product: dict, store: StoreConfig) -> bool:
    """Check if a suggest result passes the store's product type/vendor filter."""
    if store.filter_field is None:
        return True
    val = str(product.get(store.filter_field, "") or "").lower()
    target = (store.filter_value or "").lower()
    if store.filter_mode == "equals":
        return val == target
    return target in val  # "contains"


def fetch_price(store: StoreConfig, card_name: str, condition: str) -> tuple[str, str]:
    """
    Fetch the best NM (or preferred condition) price for `card_name` from `store`.

    Returns:
        (price_str, product_url) where price_str is a formatted float or "N/A"
    """
    target_keywords = CONDITION_MAP.get(condition.upper(), [condition.upper()])

    # Build suggest URL
    params = {k: v.replace("{card_name}", card_name) for k, v in store.suggest_params.items()}
    query = urllib.parse.urlencode(params)
    suggest_url = f"{store.suggest_endpoint}?{query}"

    data = _get(suggest_url)
    if data is None:
        return "N/A", ""

    products = _navigate(data, store.results_path)

    # Filter by type/vendor and availability and non-zero price
    candidates = []
    for p in products:
        if not _matches_filter(p, store):
            continue
        if not p.get(store.available_field):
            continue
        try:
            if float(p.get(store.price_field, 0)) > 0.001:
                candidates.append(p)
        except (TypeError, ValueError):
            continue

    if not candidates:
        return "N/A", ""

    # Try variant endpoint on top-3 candidates to find preferred condition
    best_price: float = float("inf")
    best_url: str = ""
    found_condition = False

    for prod in candidates[:3]:
        handle = prod.get(store.handle_field)
        if not handle:
            continue

        v_url = store.variant_endpoint.replace("{handle}", handle)
        v_data = _get(v_url, timeout=6)
        if v_data is None:
            continue

        variants = v_data.get("product", {}).get("variants", [])
        for v in variants:
            # Stock check
            if "inventory_quantity" in v and int(v.get("inventory_quantity", 0)) <= 0:
                continue

            # Condition match
            opt1 = str(v.get("option1", "") or "").upper()
            opt2 = str(v.get("option2", "") or "").upper()
            title = str(v.get("title", "") or "").upper()
            matched = any(kw in opt1 or kw in opt2 or kw in title for kw in target_keywords)

            if matched:
                try:
                    v_price = float(v.get("price", 0))
                except (TypeError, ValueError):
                    continue
                if 0.001 < v_price < best_price:
                    best_price = v_price
                    best_url = f"{store.url_prefix}{prod.get(store.url_field, '')}"
                    found_condition = True

    if found_condition:
        return f"{best_price:.2f}", best_url

    # Fallback: cheapest available candidate from suggest results (no condition filter)
    candidates.sort(key=lambda p: float(p.get(store.price_field, float("inf"))))
    best = candidates[0]
    try:
        price = float(best.get(store.price_field, 0))
    except (TypeError, ValueError):
        return "N/A", ""
    url = f"{store.url_prefix}{best.get(store.url_field, '')}"
    return f"{price:.2f}", url


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="deckbldr.py",
        description="Fetch MTG card prices from Canadian storefronts.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("input_file", help="Path to .txt or .csv decklist")
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="Output CSV path (default: prices_<timestamp>.csv)",
    )
    parser.add_argument(
        "--condition", "-c",
        default="NM",
        choices=["NM", "LP", "MP", "HP", "DMG"],
        help="Preferred card condition (default: NM)",
    )
    parser.add_argument(
        "--delay", "-d",
        type=int,
        default=1500,
        metavar="MS",
        help="Delay between API requests in milliseconds (default: 1500)",
    )
    parser.add_argument(
        "--no-confirm",
        action="store_true",
        help="Skip confirmation prompt and run immediately",
    )
    args = parser.parse_args()

    # ── Parse input file ─────────────────────────────────────────────────────
    print(f"\n  DeckBldr Price Checker")
    print(f"  {'─' * 40}")
    print(f"  Input:     {args.input_file}")
    print(f"  Condition: {args.condition}")
    print(f"  Stores:    {', '.join(s.name for s in STORES)}")

    cards = parse_file(args.input_file)
    if not cards:
        print("\n[ERROR] No cards found in the input file.", file=sys.stderr)
        sys.exit(1)

    # ── Preview ──────────────────────────────────────────────────────────────
    preview_cards(cards)

    if not args.no_confirm:
        try:
            answer = input(f"  Fetch prices for these {len(cards)} card(s)? [Y/n] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\n  Aborted.")
            sys.exit(0)
        if answer in ("n", "no"):
            print("  Aborted.")
            sys.exit(0)
        print()

    # ── Determine output path ────────────────────────────────────────────────
    if args.output:
        output_path = args.output
    else:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = f"prices_{ts}.csv"

    delay_sec = args.delay / 1000.0
    store_names = [s.name for s in STORES]

    # results[card_name][store_name] = price_str
    results: dict[str, dict[str, str]] = {card: {} for card in cards}

    total = len(cards) * len(STORES)
    done = 0

    # ── Fetch prices ─────────────────────────────────────────────────────────
    for store in STORES:
        print(f"  Querying {store.name} ({store.currency})...")
        for card in cards:
            done += 1
            pct = int(done / total * 100)
            # Overwrite current line for a progress ticker
            print(f"    [{done}/{total}] {pct:3d}%  {card[:50]:<50}", end="\r")

            price_str, _ = fetch_price(store, card, args.condition)
            results[card][store.name] = price_str

            time.sleep(delay_sec)

        print()  # newline after store is done

    # ── Compute cheapest ─────────────────────────────────────────────────────
    print(f"\n  Writing results to {output_path}...")

    fieldnames = ["card_name"] + [f"{s.name} ({s.currency})" for s in STORES] + [
        "Cheapest Store", "Cheapest Price (CAD)"
    ]

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for card in cards:
            row: dict[str, str] = {"card_name": card}

            best_price: Optional[float] = None
            best_store: str = "N/A"

            for store in STORES:
                col = f"{store.name} ({store.currency})"
                price_str = results[card].get(store.name, "N/A")
                row[col] = price_str

                if price_str != "N/A":
                    try:
                        p = float(price_str)
                        if best_price is None or p < best_price:
                            best_price = p
                            best_store = store.name
                    except ValueError:
                        pass

            row["Cheapest Store"] = best_store
            row["Cheapest Price (CAD)"] = f"{best_price:.2f}" if best_price is not None else "N/A"

            writer.writerow(row)

    # ── Summary ──────────────────────────────────────────────────────────────
    found = sum(
        1 for card in cards
        if any(results[card].get(s.name, "N/A") != "N/A" for s in STORES)
    )
    not_found = len(cards) - found

    print(f"\n  ✓ Done!")
    print(f"    Cards found:     {found}/{len(cards)}")
    if not_found:
        print(f"    Not found (N/A): {not_found}")
    print(f"    Output:          {output_path}\n")


if __name__ == "__main__":
    main()
