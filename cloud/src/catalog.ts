export const ENTITIES = {
  yapi: { label: "雅啤精釀", kind: "business" },
  taros: { label: "塔羅斯Talos", kind: "business" },
  beerwang: { label: "啤酒王", kind: "business" },
  superhour: { label: "超時餐飲", kind: "business" },
  kaipi: { label: "開啤", kind: "business" },
  personal: { label: "日常生活支出", kind: "personal" },
} as const;

export type EntityKey = keyof typeof ENTITIES;
export type EntityKind = "business" | "personal" | "unclassified";

export const INCOME_CATEGORIES = [
  "瓶裝啤酒銷售",
  "桶裝啤酒銷售",
  "代工收入",
  "教育課程",
  "設備銷售",
  "工程案收入",
  "餐飲收入",
  "自釀材料銷售",
  "原料零售",
  "其他收入",
] as const;

export const EXPENSE_CATEGORIES = [
  "原料-麥芽",
  "原料-啤酒花",
  "原料-酵母",
  "包材-瓶子",
  "包材-紙箱",
  "包材-標籤",
  "耗材-CO₂",
  "耗材-柴油",
  "人力-Tonic",
  "人力-助理",
  "人力-臨時工",
  "勞健保",
  "房租",
  "電費",
  "水費",
  "運費",
  "稅務-酒稅",
  "稅務-營業稅",
  "政府規費",
  "設備採購",
  "設備折舊",
  "進口-關稅",
  "進口-貨款",
  "行銷廣告",
  "日常生活支出",
  "雜支",
  "其他支出",
] as const;

const ENTITY_ALIASES: Record<string, EntityKey> = {
  yapi: "yapi",
  "tonic brewery": "yapi",
  雅啤精釀: "yapi",
  taros: "taros",
  塔羅斯: "taros",
  塔羅斯talos: "taros",
  beerwang: "beerwang",
  啤酒王: "beerwang",
  superhour: "superhour",
  超時: "superhour",
  超時餐飲: "superhour",
  kaipi: "kaipi",
  開啤: "kaipi",
  personal: "personal",
  日常生活: "personal",
  日常生活支出: "personal",
  個人: "personal",
};

export function normalizeEntity(value: unknown): EntityKey | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return ENTITY_ALIASES[text.toLowerCase()] ?? ENTITY_ALIASES[text] ?? null;
}

export function entityLabel(entity: string): string {
  if (entity in ENTITIES) return ENTITIES[entity as EntityKey].label;
  return entity;
}

export function entityKind(entity: string): EntityKind {
  if (entity in ENTITIES) return ENTITIES[entity as EntityKey].kind;
  return "unclassified";
}

export function categoryInCatalog(type: "income" | "expense", category: string): boolean {
  const list = type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  return (list as readonly string[]).includes(category);
}

export const CASH_NET_DISCLAIMER =
  "淨額＝收入−支出，不是銀行餘額，也不是完整損益。固定支出的帳單、實付與未來月額不會自動變成交易。資料若還沒對齊，不能把現金淨額當成獲利。";
