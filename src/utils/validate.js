const validators = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
};

export function validateBody(body, requiredFields, optionalFields = {}) {
  if (!body || Array.isArray(body) || typeof body !== "object") {
    return "El body debe ser un objeto JSON";
  }

  for (const [field, type] of Object.entries(requiredFields)) {
    if (!(field in body)) {
      return `El campo \"${field}\" es obligatorio`;
    }

    if (!validators[type](body[field])) {
      return `El campo \"${field}\" debe ser de tipo ${type}`;
    }
  }

  for (const [field, type] of Object.entries(optionalFields)) {
    if (field in body && !validators[type](body[field])) {
      return `El campo \"${field}\" debe ser de tipo ${type}`;
    }
  }

  return null;
}
