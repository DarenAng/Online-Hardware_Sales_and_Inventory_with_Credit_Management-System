// ============================================================
// helpers.js -- small helpers the route files share: word-start search and date text
// Loaded by: server.js (handed on to the route files).
// Never sent to a browser.
// ============================================================

// A search matches the start of a field (LIKE 'text%'). % and _ are escaped.
// Example: searchPrefix("50%") -> "50\\%%"  (the user's % is not a wildcard)
function searchPrefix(text) {
  // put a backslash in front of every \ % and _ the user typed
  return String(text).replace(/[\\%_]/g, "\\$&") + "%";
}

// The characters a word can start after, besides the start of the field. The
// screen counts any character that is not a letter or digit; these are the
// ones that turn up in names, emails, phone numbers and addresses.
const WORD_SEPARATORS = [" ", ".", "@", "-", "_", "(", "/", ","];

// The same rule as startsAWord in shared/data-panel.js: a column matches when
// it starts with the text or one of its words does ("c" finds "Carl",
// "Mark Cole" and "juan@cruz.com", not "Lace"). Pass the column names and the
// typed text; the patterns for each column are added to params, and the SQL
// to put in WHERE is returned.
// Example: wordStartSearch(["u.email"], "ca", params)
//   -> "(u.email LIKE ? OR u.email LIKE ? OR ...)"   one test for the start
//      of the field ("ca%") and one for each separator ("% ca%", "%.ca%", ...)
function wordStartSearch(columns, text, params) {
  const atStart = searchPrefix(text);

  // "%" then the separator then the text; the separator is escaped as well, since "_" is a wildcard
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

// true for a date written like "2026-09-24" (4 digits - 2 digits - 2 digits)
function isDateText(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

// ==========================================
// ADDRESSES IN PARTS -- a delivery and a customer are both addressed this way
// ==========================================
// Text from a form box: not text -> "", extra spaces become one.
function tidy(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

// The parts of an address and the longest each may be. The cashier fills them
// in one by one; they are saved in their own columns, and joined into the one
// line every other screen shows.
// [key, what it is called, longest, required]. Not every house has a number or
// a street, so the house number and street may be left out.
const ADDRESS_PARTS = [
  ["street", "house number and street", 150, false],
  ["barangay", "barangay", 100, true],
  ["city", "town or city", 100, true],
  ["province", "province", 100, true]
];

// "Wawa" is written "Brgy. Wawa" in the line; a barangay already written
// with its word (Brgy., Barangay, Poblacion, Zone, Purok, Sitio) is left alone.
function barangayLine(barangay) {
  if (/^(brgy|barangay|poblacion|zone|purok|sitio)\b/i.test(barangay)) return barangay;
  return "Brgy. " + barangay;
}

// The whole address as one line: street (when there is one), barangay, town or
// city, province, then the landmark in brackets.
function buildFullAddress(parts) {
  let line = barangayLine(parts.barangay) + ", " + parts.city + ", " + parts.province;
  if (parts.street !== "") line = parts.street + ", " + line;
  if (parts.landmark !== "") line += " (Landmark: " + parts.landmark + ")";
  return line;
}

// The parts of an address out of a request body, tidied.
function addressPartsFrom(body) {
  return {
    street: tidy(body.street),
    barangay: tidy(body.barangay),
    city: tidy(body.city),
    province: tidy(body.province),
    landmark: tidy(body.landmark)
  };
}

// null when the parts are fine, otherwise the one sentence to show. whose is
// the words after "for the": "delivery address", "customer's address".
// streetRequired: a customer's record needs the house number and street too;
// a delivery address may leave it out.
function addressPartsProblem(parts, whose, streetRequired) {
  for (let i = 0; i < ADDRESS_PARTS.length; i++) {
    const key = ADDRESS_PARTS[i][0];
    const label = ADDRESS_PARTS[i][1];
    const longest = ADDRESS_PARTS[i][2];
    const required = ADDRESS_PARTS[i][3] || (streetRequired === true && key === "street");
    // a barangay can be a single number ("5"); the other parts are at least two characters
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

module.exports = {
  searchPrefix: searchPrefix,
  wordStartSearch: wordStartSearch,
  isDateText: isDateText,
  tidy: tidy,
  buildFullAddress: buildFullAddress,
  addressPartsFrom: addressPartsFrom,
  addressPartsProblem: addressPartsProblem
};
