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

module.exports = {
  searchPrefix: searchPrefix,
  wordStartSearch: wordStartSearch,
  isDateText: isDateText
};
