const MATCH_THRESHOLDS = {
  excellent: 85,
  strong: 70,
  possible: 55,
  minimum: 55
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "by", "for", "from", "i", "in", "is",
  "it", "my", "near", "of", "on", "or", "the", "this", "to", "with"
]);

const SYNONYMS = {
  airpods: "earbuds",
  earbud: "earbuds",
  earbuds: "earbuds",
  earphone: "earphones",
  earphones: "earphones",
  headphones: "earphones",
  mobile: "phone",
  smartphone: "phone",
  cellphone: "phone",
  "smart watch": "smartwatch",
  smartwatches: "smartwatch",
  watches: "watch",
  maths: "mathematics",
  math: "mathematics",
  calc: "calculator",
  idcard: "id card",
  identity: "id"
};

const COLORS = new Set([
  "black", "white", "blue", "red", "green", "yellow", "silver", "gold",
  "grey", "gray", "pink", "purple", "brown", "orange", "maroon"
]);

const COMMON_BRANDS = new Set([
  "apple", "samsung", "noise", "boat", "boAt".toLowerCase(), "casio", "hp",
  "dell", "lenovo", "asus", "acer", "oneplus", "oppo", "vivo", "realme",
  "xiaomi", "redmi", "mi", "sony", "jbl", "zebronics", "logitech"
]);

const COMMON_ITEMS = new Set([
  "watch", "smartwatch", "phone", "calculator", "wallet", "id", "card",
  "book", "earbuds", "earphones", "charger", "bag", "keys", "key", "laptop",
  "tablet", "pen", "notebook", "bottle", "spectacles", "glasses", "helmet",
  "pendrive", "usb", "mouse", "keyboard"
]);

function normalizeText(value = "") {
  let text = String(value || "").toLowerCase();

  for (const [from, to] of Object.entries(SYNONYMS)) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, "g"), to);
  }

  return text
    .replace(/smart\s+watch/g, "smartwatch")
    .replace(/id\s+card/g, "id card")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenize(value = "") {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getItemText(item) {
  return [item.title, item.description, item.category, item.location].filter(Boolean).join(" ");
}

function extractKeywords(item) {
  return unique(tokenize(getItemText(item)));
}

function extractAttributes(item) {
  const keywords = extractKeywords(item);
  const colors = keywords.filter((word) => COLORS.has(word));
  const brands = keywords.filter((word) => COMMON_BRANDS.has(word));
  const itemWords = keywords.filter((word) => COMMON_ITEMS.has(word));

  return {
    colors,
    brands,
    items: itemWords,
    keywords
  };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}

function wordSimilarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);

  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.88;

  const distance = levenshtein(left, right);
  return Math.max(0, 1 - distance / Math.max(left.length, right.length));
}

function fuzzySetSimilarity(leftTokens, rightTokens) {
  if (!leftTokens.length || !rightTokens.length) return 0;

  const leftScores = leftTokens.map((left) => Math.max(...rightTokens.map((right) => wordSimilarity(left, right))));
  const rightScores = rightTokens.map((right) => Math.max(...leftTokens.map((left) => wordSimilarity(right, left))));
  const allScores = [...leftScores, ...rightScores];

  return allScores.reduce((sum, score) => sum + score, 0) / allScores.length;
}

function calculateTextSimilarity(a, b) {
  const aTokens = unique(tokenize([a.title, a.description].join(" ")));
  const bTokens = unique(tokenize([b.title, b.description].join(" ")));
  return fuzzySetSimilarity(aTokens, bTokens);
}

function calculateCategoryScore(a, b) {
  const left = normalizeText(a.category);
  const right = normalizeText(b.category);

  if (!left || !right) return 0.35;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.75;
  return wordSimilarity(left, right) >= 0.78 ? 0.55 : 0.05;
}

function calculateLocationScore(a, b) {
  const leftText = normalizeText(a.location);
  const rightText = normalizeText(b.location);

  if (leftText && rightText && (leftText === rightText || leftText.includes(rightText) || rightText.includes(leftText))) {
    return leftText === rightText ? 1 : 0.9;
  }

  const left = unique(tokenize(a.location));
  const right = unique(tokenize(b.location));

  if (!left.length || !right.length) return 0.35;
  return fuzzySetSimilarity(left, right);
}

function calculateDateScore(a, b) {
  const left = new Date(a.itemDate || a.item_date);
  const right = new Date(b.itemDate || b.item_date);

  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return 0.35;

  const diffDays = Math.abs(left - right) / 86400000;
  if (diffDays <= 0.5) return 1;
  if (diffDays <= 2) return 0.92;
  if (diffDays <= 7) return 0.72;
  if (diffDays <= 14) return 0.5;
  if (diffDays <= 30) return 0.28;
  return 0.12;
}

function overlapScore(leftValues, rightValues) {
  if (!leftValues.length && !rightValues.length) return null;
  if (!leftValues.length || !rightValues.length) return 0.25;

  const score = fuzzySetSimilarity(leftValues, rightValues);
  return score >= 0.72 ? score : 0;
}

function calculateAttributeScore(a, b) {
  const left = extractAttributes(a);
  const right = extractAttributes(b);
  const scores = [
    overlapScore(left.colors, right.colors),
    overlapScore(left.brands, right.brands),
    overlapScore(left.items, right.items),
    fuzzySetSimilarity(left.keywords.slice(0, 12), right.keywords.slice(0, 12))
  ].filter((score) => score !== null);

  if (!scores.length) return 0.35;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function getConfidence(score) {
  if (score >= MATCH_THRESHOLDS.excellent) return "Excellent Match";
  if (score >= MATCH_THRESHOLDS.strong) return "Strong Match";
  if (score >= MATCH_THRESHOLDS.possible) return "Possible Match";
  return "Low Match";
}

function generateMatchReasons(signals, a, b) {
  const reasons = [];
  const dateA = new Date(a.itemDate || a.item_date);
  const dateB = new Date(b.itemDate || b.item_date);

  if (signals.category >= 0.95) reasons.push("Same category");
  else if (signals.category >= 0.55) reasons.push("Related category");

  if (signals.text >= 0.78) reasons.push("Very similar title or description");
  else if (signals.text >= 0.55) reasons.push("Similar item keywords");

  if (signals.location >= 0.82) reasons.push("Very similar location");
  else if (signals.location >= 0.55) reasons.push("Related location");

  if (!Number.isNaN(dateA.getTime()) && !Number.isNaN(dateB.getTime())) {
    const days = Math.round(Math.abs(dateA - dateB) / 86400000);
    if (days === 0) reasons.push("Reported on the same day");
    else if (days <= 7) reasons.push(`Date difference: ${days} day${days === 1 ? "" : "s"}`);
  }

  const left = extractAttributes(a);
  const right = extractAttributes(b);
  const sharedColors = left.colors.filter((color) => right.colors.some((other) => wordSimilarity(color, other) >= 0.8));
  const sharedBrands = left.brands.filter((brand) => right.brands.some((other) => wordSimilarity(brand, other) >= 0.8));
  const sharedItems = left.items.filter((item) => right.items.some((other) => wordSimilarity(item, other) >= 0.8));

  if (sharedColors.length) reasons.push(`Matching color: ${sharedColors[0]}`);
  if (sharedBrands.length) reasons.push(`Matching brand: ${sharedBrands[0]}`);
  if (sharedItems.length) reasons.push(`Matching item type: ${sharedItems[0]}`);

  if (!reasons.length && signals.attributes >= 0.55) {
    reasons.push("Several keywords look related");
  }

  return reasons.slice(0, 5);
}

function calculateFinalMatchScore(source, candidate) {
  if (!source || !candidate || source.itemType === candidate.itemType) {
    return null;
  }

  const signals = {
    text: calculateTextSimilarity(source, candidate),
    category: calculateCategoryScore(source, candidate),
    location: calculateLocationScore(source, candidate),
    date: calculateDateScore(source, candidate),
    attributes: calculateAttributeScore(source, candidate)
  };

  const weights = {
    text: 0.3,
    category: 0.2,
    location: 0.2,
    date: 0.15,
    attributes: 0.15
  };

  let weightedScore = Object.entries(weights).reduce((sum, [key, weight]) => {
    return sum + signals[key] * weight;
  }, 0);

  if (signals.category < 0.2) {
    weightedScore *= 0.62;
  }

  const score = Math.round(Math.max(0, Math.min(1, weightedScore)) * 100);

  return {
    score,
    confidence: getConfidence(score),
    signals,
    reasons: generateMatchReasons(signals, source, candidate)
  };
}

function findBestMatches(source, candidates, options = {}) {
  const minimumScore = options.minimumScore ?? MATCH_THRESHOLDS.minimum;
  const limit = options.limit ?? 5;

  return candidates
    .filter((candidate) => candidate.itemType !== source.itemType && candidate.status !== "resolved")
    .map((candidate) => {
      const result = calculateFinalMatchScore(source, candidate);
      if (!result) return null;
      return {
        ...result,
        item: candidate
      };
    })
    .filter((match) => match && match.score >= minimumScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = {
  MATCH_THRESHOLDS,
  normalizeText,
  extractKeywords,
  calculateTextSimilarity,
  calculateCategoryScore,
  calculateLocationScore,
  calculateDateScore,
  calculateAttributeScore,
  calculateFinalMatchScore,
  findBestMatches
};
