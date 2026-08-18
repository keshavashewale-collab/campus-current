const isFileProtocol = window.location.protocol === "file:";

export const API_BASE_URL = isFileProtocol
  ? "http://localhost:3000/api"
  : `${window.location.origin}/api`;
