/**
 * FormPilot random test-data generator.
 * Fills every visible field of a form (or formless group) with believable fake
 * data. One fake person is generated per fill, so name, email, username and
 * the password/confirm-password pair all agree with each other.
 *
 * Emails use example.com and phone numbers use the reserved 555-01xx range, so
 * nothing generated here belongs to a real person.
 */

const FormPilotTestData = (() => {
  const FIRST_NAMES = [
    "Ada", "Grace", "Alan", "Linus", "Margaret", "Dennis", "Katherine", "Tim", "Radia", "Ken",
    "Barbara", "Guido", "Hedy", "Donald", "Sophie", "Yusuf", "Mei", "Omar", "Priya", "Lucas"
  ];
  const LAST_NAMES = [
    "Lovelace", "Hopper", "Turing", "Torvalds", "Hamilton", "Ritchie", "Johnson", "Berners",
    "Perlman", "Thompson", "Liskov", "Rossum", "Lamarr", "Knuth", "Wilson", "Khan", "Chen", "Haddad"
  ];
  const STREETS = ["Maple Street", "Oak Avenue", "Cedar Lane", "Pine Road", "Elm Court", "Lakeview Drive", "Sunset Boulevard", "Highland Way"];
  const PLACES = [
    { city: "Springfield", state: "Illinois", postalCode: "62704" },
    { city: "Portland", state: "Oregon", postalCode: "97205" },
    { city: "Austin", state: "Texas", postalCode: "78701" },
    { city: "Denver", state: "Colorado", postalCode: "80202" },
    { city: "Madison", state: "Wisconsin", postalCode: "53703" },
    { city: "Raleigh", state: "North Carolina", postalCode: "27601" }
  ];
  const AREA_CODES = ["212", "312", "415", "503", "512", "617", "720", "919"];
  const COMPANIES = ["Northwind Traders", "Contoso Ltd", "Fabrikam Inc", "Adventure Works", "Tailspin Toys", "Litware", "Proseware", "Wingtip Supply"];
  const JOB_TITLES = ["Software Engineer", "Product Manager", "Designer", "QA Analyst", "Data Analyst", "Support Lead", "Marketing Manager", "Accountant"];
  const LOREM = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(" ");

  // Checkboxes about agreeing to something get ticked so forms can actually submit.
  const CONSENT_PATTERN = /\b(terms|agree|consent|accept|privacy|policy|conditions)\b/i;
  const AGE_PATTERN = /(^|[^a-z])age([^a-z]|$)/i;

  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const int = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const pad = (number) => String(number).padStart(2, "0");
  const toIsoDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);

  function lorem(wordCount) {
    return Array.from({ length: wordCount }, () => pick(LOREM)).join(" ");
  }

  function sentence() {
    return `${capitalize(lorem(int(6, 12)))}.`;
  }

  function makePassword() {
    const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*"];
    const chars = sets.map((set) => pick(set.split("")));
    const all = sets.join("").split("");
    while (chars.length < 14) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = int(0, i);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join("");
  }

  function makePerson() {
    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);
    const suffix = int(10, 99);
    const place = pick(PLACES);
    const company = pick(COMPANIES);
    const born = new Date(int(1960, 2004), int(0, 11), int(1, 28));

    return {
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      email: `${firstName}.${lastName}${suffix}@example.com`.toLowerCase(),
      username: `${firstName}${lastName}${suffix}`.toLowerCase(),
      phone: `(${pick(AREA_CODES)}) 555-01${pad(int(0, 99))}`,
      website: `https://www.${company.toLowerCase().replace(/[^a-z]+/g, "")}.example`,
      company,
      jobTitle: pick(JOB_TITLES),
      address1: `${int(100, 9899)} ${pick(STREETS)}`,
      address2: `Apt ${int(1, 40)}`,
      city: place.city,
      state: place.state,
      postalCode: place.postalCode,
      country: "United States",
      birthday: toIsoDate(born),
      password: makePassword()
    };
  }

  function parseDate(text) {
    if (!text) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function randomDate(field, key, person) {
    const now = new Date();
    const isBirthday = key === "birthday";
    const min = parseDate(field.min) || (isBirthday ? new Date(1960, 0, 1) : new Date(now.getTime() - 365 * 864e5));
    const max =
      parseDate(field.max) ||
      (isBirthday ? new Date(now.getFullYear() - 18, 11, 31) : new Date(now.getTime() + 365 * 864e5));

    if (isBirthday) {
      const born = parseDate(person.birthday);
      if (born && born >= min && born <= max) return toIsoDate(born);
    }
    if (min >= max) return toIsoDate(min);
    return toIsoDate(new Date(min.getTime() + Math.random() * (max.getTime() - min.getTime())));
  }

  function randomNumber(field, meta) {
    const looksLikeAge = AGE_PATTERN.test([meta.name, meta.id, meta.label, meta.placeholder].join(" "));
    const min = field.min !== "" ? Number(field.min) : looksLikeAge ? 18 : 1;
    const max = field.max !== "" ? Number(field.max) : looksLikeAge ? 65 : min + 99;
    const step = field.step && field.step !== "any" ? Number(field.step) : 1;

    if (![min, max, step].every(Number.isFinite) || step <= 0 || max < min) return String(min || 1);

    const steps = Math.floor((max - min) / step);
    return String(Number((min + int(0, steps) * step).toFixed(6)));
  }

  function valueForInput(field, type, key, meta, person) {
    switch (type) {
      case "email":
        return person.email;
      case "tel":
        return person.phone;
      case "url":
        return person.website;
      case "password":
        return person.password;
      case "number":
      case "range":
        return randomNumber(field, meta);
      case "date":
        return randomDate(field, key, person);
      case "month":
        return randomDate(field, key, person).slice(0, 7);
      case "time":
        return `${pad(int(8, 18))}:${pad(int(0, 59))}`;
      case "datetime-local":
        return `${randomDate(field, key, person)}T${pad(int(8, 18))}:${pad(int(0, 59))}`;
      case "color":
        return `#${int(0, 0xffffff).toString(16).padStart(6, "0")}`;
      case "week":
        return null;
      default:
        if (key && person[key]) return person[key];
        if (type === "textarea") return Array.from({ length: int(2, 3) }, sentence).join(" ");
        return capitalize(lorem(int(2, 3)));
    }
  }

  function fillSelect(select, key, person) {
    const options = Array.from(select.options).filter((option) => option.value !== "" && !option.disabled);
    if (options.length === 0) return false;

    const matched = key && person[key] ? FormPilotAutofill.findMatchingOption(select, person[key]) : null;
    FormPilotAutofill.setSelectValue(select, (matched || pick(options)).value);
    return true;
  }

  function fillField(field, type, person) {
    const meta = FormPilotFingerprint.buildFieldMetadata(field, 0);
    const key = FormPilotFieldTypes.classify(meta);

    if (type === "checkbox") {
      const wording = [meta.label, meta.name, meta.id].join(" ");
      FormPilotAutofill.setChecked(field, CONSENT_PATTERN.test(wording) || Math.random() < 0.5);
      return true;
    }

    if (type === "select") return fillSelect(field, key, person);

    // Passwords get a generated one; card numbers, tokens and the like are left alone.
    if (key !== "password" && FormPilotFieldTypes.isSensitive(meta)) return false;

    let value = valueForInput(field, type, key, meta, person);
    if (value == null) return false;

    if (field.maxLength >= 0 && value.length > field.maxLength) value = value.slice(0, field.maxLength);
    FormPilotAutofill.setNativeValue(field, value);
    return true;
  }

  /** Fills a form or formless group with random data. Returns { filled, skipped }. */
  function fill(container) {
    const person = makePerson();
    const radioGroups = new Map();
    let filled = 0;
    let skipped = 0;

    for (const field of FormPilotDetector.getUsableFields(container)) {
      const type = FormPilotFingerprint.getFieldType(field);

      if (type === "radio") {
        const groupKey = field.name || field;
        if (!radioGroups.has(groupKey)) radioGroups.set(groupKey, []);
        radioGroups.get(groupKey).push(field);
        continue;
      }

      if (type !== "file" && fillField(field, type, person)) filled += 1;
      else skipped += 1;
    }

    for (const radios of radioGroups.values()) {
      FormPilotAutofill.setChecked(pick(radios), true);
      filled += 1;
    }

    return { filled, skipped };
  }

  return { fill, makePerson };
})();
