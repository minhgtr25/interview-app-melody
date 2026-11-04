export const BUILDINGS = [
  { code: "BE", name: "Tòa Beta" },
  { code: "DE", name: "Tòa Delta" },
  { code: "EP", name: "Tòa Epsilon" },
  { code: "AL", name: "Tòa Alpha" },
] as const;

export type BuildingCode = (typeof BUILDINGS)[number]["code"];

export type RoomNumber = string;

export function isBuildingCode(value: unknown): value is BuildingCode {
  return BUILDINGS.some((building) => building.code === value);
}

export function isRoomNumber(value: unknown): value is RoomNumber {
  return typeof value === "string" && /^[1-4](?:0[1-9]|[1-3][0-9]|40)$/.test(value);
}

export function roomCode(building: BuildingCode, number: RoomNumber) {
  return `${building}-${number}`;
}
