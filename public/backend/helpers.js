function searchPrefix(text) {
  return String(text).replace(/[\\%_]/g, "\\$&") + "%";
}

const WORD_SEPARATORS = [" ", ".", "@", "-", "_", "(", "/", ","];

function wordStartSearch(columns, text, params) {
  const atStart = searchPrefix(text);

  const patterns = [atStart];
  for (let separatorIndex = 0; separatorIndex < WORD_SEPARATORS.length; separatorIndex++) {
    const separator = WORD_SEPARATORS[separatorIndex];
    patterns.push("%" + separator.replace(/[\\%_]/g, "\\$&") + atStart);
  }

  const tests = [];
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    const column = columns[columnIndex];
    for (let patternIndex = 0; patternIndex < patterns.length; patternIndex++) {
      const pattern = patterns[patternIndex];
      tests.push(column + " LIKE ?");
      params.push(pattern);
    }
  }
  return "(" + tests.join(" OR ") + ")";
}

function isDateText(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function tidy(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

const ADDRESS_PARTS = [
  ["street", "house number and street", 150, false],
  ["barangay", "barangay", 100, true],
  ["city", "town or city", 100, true],
  ["province", "province", 100, true]
];

function barangayLine(barangay) {
  if (/^(brgy|barangay|poblacion|zone|purok|sitio)\b/i.test(barangay)) return barangay;
  return "Brgy. " + barangay;
}

function buildFullAddress(parts) {
  let line = barangayLine(parts.barangay) + ", " + parts.city + ", " + parts.province;
  if (parts.street !== "") line = parts.street + ", " + line;
  if (parts.landmark !== "") line += " (Landmark: " + parts.landmark + ")";
  return line;
}

function addressPartsFrom(body) {
  return {
    street: tidy(body.street),
    barangay: tidy(body.barangay),
    city: tidy(body.city),
    province: tidy(body.province),
    landmark: tidy(body.landmark)
  };
}

function addressPartsProblem(parts, whose, streetRequired) {
  for (let i = 0; i < ADDRESS_PARTS.length; i++) {
    const key = ADDRESS_PARTS[i][0];
    const label = ADDRESS_PARTS[i][1];
    const longest = ADDRESS_PARTS[i][2];
    const required = ADDRESS_PARTS[i][3] || (streetRequired === true && key === "street");
    let shortest = 2;
    if (key === "barangay") shortest = 1;
    if (required && parts[key].length < shortest) {
      return "Enter the " + label + " for the " + whose + ".";
    }
    if (!required && parts[key] !== "" && parts[key].length < shortest) {
      return "The " + label + " is too short; leave it empty if there is none.";
    }
    if (parts[key].length > longest) {
      return "The " + label + " is at most " + longest + " characters.";
    }
  }
  if (parts.landmark.length > 150) {
    return "The landmark is at most 150 characters.";
  }
  return null;
}

const MEASURED_UNITS = ["kilogram", "kg", "gram", "meter", "metre", "liter", "litre", "foot", "gallon"];

function isMeasuredUnit(unit) {
  return MEASURED_UNITS.includes(String(unit || "").trim().toLowerCase());
}

module.exports = {
  searchPrefix: searchPrefix,
  isMeasuredUnit: isMeasuredUnit,
  wordStartSearch: wordStartSearch,
  isDateText: isDateText,
  tidy: tidy,
  buildFullAddress: buildFullAddress,
  addressPartsFrom: addressPartsFrom,
  addressPartsProblem: addressPartsProblem
};
