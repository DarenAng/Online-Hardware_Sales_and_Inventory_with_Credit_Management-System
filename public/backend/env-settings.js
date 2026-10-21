function numberSetting(value, defaultValue) {
  if (Number(value) > 0) {
    return Number(value);
  }
  return defaultValue;
}

module.exports = { numberSetting: numberSetting };
