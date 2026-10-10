/**
 * Field classification for FormPilot.
 * Works on field metadata (see FormPilotFingerprint.buildFieldMetadata), so it
 * can run on live fields and on saved presets alike.
 *
 * Used for:
 *   - global profiles (which profile value belongs in which field)
 *   - the random test-data generator
 *   - spotting sensitive fields (passwords, cards, tokens)
 */

const FormPilotFieldTypes = (() => {
  /** Values a global profile can hold, in the order the options page shows them. */
  const PROFILE_FIELDS = [
    { key: "fullName", label: "Full name", group: "Name" },
    { key: "firstName", label: "First name", group: "Name" },
    { key: "lastName", label: "Last name", group: "Name" },
    { key: "email", label: "Email", group: "Contact", inputType: "email" },
    { key: "phone", label: "Phone", group: "Contact", inputType: "tel" },
    { key: "website", label: "Website", group: "Contact", inputType: "url" },
    { key: "username", label: "Username", group: "Contact" },
    { key: "company", label: "Company", group: "Work" },
    { key: "jobTitle", label: "Job title", group: "Work" },
    { key: "address1", label: "Address line 1", group: "Address" },
    { key: "address2", label: "Address line 2", group: "Address" },
    { key: "city", label: "City", group: "Address" },
    { key: "state", label: "State / province", group: "Address" },
    { key: "postalCode", label: "Postal / ZIP code", group: "Address" },
    { key: "country", label: "Country", group: "Address" },
    { key: "birthday", label: "Birthday", group: "Personal", inputType: "date" }
  ];

  /** HTML autocomplete tokens that settle the question without guessing from names. */
  const AUTOCOMPLETE_KEYS = {
    name: "fullName",
    "given-name": "firstName",
    "family-name": "lastName",
    email: "email",
    tel: "phone",
    "tel-national": "phone",
    url: "website",
    username: "username",
    organization: "company",
    "organization-title": "jobTitle",
    "street-address": "address1",
    "address-line1": "address1",
    "address-line2": "address2",
    "address-level2": "city",
    "address-level1": "state",
    "postal-code": "postalCode",
    country: "country",
    "country-name": "country",
    bday: "birthday",
    "new-password": "password",
    "current-password": "password"
  };

  /**
   * Checked in order, first hit wins. Each pattern is tried against each of the
   * field's name / id / placeholder / aria-label / label on its own, so a
   * "Company name" field never reaches the plain "name" rule.
   */
  const TEXT_RULES = [
    ["email", /\be ?mail\b/],
    ["phone", /\b(phone|mobile|cell|telephone|tel)\b/],
    ["website", /\b(website|web ?site|homepage|url)\b/],
    ["birthday", /\b(birth ?day|birth ?date|date of birth|dob|bday)\b/],
    ["username", /\b(user ?name|user ?id|login|handle)\b/],
    ["firstName", /\b(first ?name|given ?name|fname|forename)\b/],
    ["lastName", /\b(last ?name|family ?name|surname|lname)\b/],
    ["company", /\b(company|organi[sz]ation|employer|business)\b/],
    ["jobTitle", /\b(job ?title|position|occupation|designation)\b/],
    ["address2", /\b(address ?(line ?)?(2|two)|apt|apartment|suite)\b/],
    ["address2", /^(unit|flat|unit (no|number)|flat (no|number))$/],
    ["postalCode", /\b(zip|postal|post ?code|pin ?code)\b/],
    ["city", /\b(city|town|suburb|locality)\b/],
    ["state", /\b(state|province|region|county|prefecture)\b/],
    ["country", /\bcountr(y|ies)\b/],
    ["address1", /\b(address|street|addr)\b/],
    // Anchored on purpose: "project name" or "team name" must not get a person's name.
    ["fullName", /^(full ?name|your ?name|name|contact name|customer name|recipient|recipient name)$/]
  ];

  /** Technical addresses/URLs that merely contain "address" or "url": never personal data. */
  const TECHNICAL_TEXT = /\b(ip|mac|wallet|contract|webhook|callback|redirect|api|endpoint)\b.*\b(address|url|uri)\b/;

  const SENSITIVE_AUTOCOMPLETE = /^(cc-|one-time-code$|new-password$|current-password$)/;
  const SENSITIVE_TEXT =
    /\b(card ?(number|no|num)|credit ?card|debit ?card|cvv|cvc|csc|security ?code|iban|ssn|social ?security|passcode|otp|one ?time (code|password)|secret|api ?key|private ?key|(access|auth|bearer) ?token)\b/;

  function clean(value) {
    return String(value ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function textCandidates(meta) {
    return [meta.name, meta.id, meta.placeholder, meta.ariaLabel, meta.label].map(clean).filter(Boolean);
  }

  function autocompleteTokens(meta) {
    return String(meta.autocomplete || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  /** Returns a profile key (or "password") for a field, or null when nothing fits. */
  function classify(meta) {
    if (!meta) return null;

    for (const token of autocompleteTokens(meta).reverse()) {
      if (AUTOCOMPLETE_KEYS[token]) return AUTOCOMPLETE_KEYS[token];
    }

    const type = (meta.type || "").toLowerCase();
    if (type === "password") return "password";

    const candidates = textCandidates(meta);
    if (candidates.some((candidate) => TECHNICAL_TEXT.test(candidate))) return null;

    if (type === "email") return "email";
    if (type === "tel") return "phone";
    if (type === "url") return "website";

    for (const [key, pattern] of TEXT_RULES) {
      if (candidates.some((candidate) => pattern.test(candidate))) return key;
    }

    return null;
  }

  /** True for passwords, payment details, one-time codes and secret-looking tokens. */
  function isSensitive(meta) {
    if (!meta) return false;
    if ((meta.type || "").toLowerCase() === "password") return true;
    if (autocompleteTokens(meta).some((token) => SENSITIVE_AUTOCOMPLETE.test(token))) return true;
    return textCandidates(meta).some((candidate) => SENSITIVE_TEXT.test(candidate));
  }

  return { PROFILE_FIELDS, classify, isSensitive };
})();
