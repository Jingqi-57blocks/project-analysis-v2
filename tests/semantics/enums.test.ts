import { describe, expect, it } from "vitest";

import { commonTablePrefix } from "../../engine/modules/features.js";
import { bestSetFor, nameTokens, resolveValue, valueSetsIn } from "../../engine/semantics/enums.js";

describe("valueSetsIn — Go", () => {
  it("numbers an iota block from its offset", () => {
    const sets = valueSetsIn(
      "svc",
      "constant/order.go",
      `package constant

type OrderStatusC uint8

const (
	OrderDraftC OrderStatusC = iota + 1
	OrderPlacedC
	OrderShippedC
	OrderDeliveredC
)
`,
    );

    expect(sets).toHaveLength(1);
    expect(sets[0]!.name).toBe("OrderStatusC");
    expect(sets[0]!.members).toEqual([
      { name: "OrderDraftC", value: 1 },
      { name: "OrderPlacedC", value: 2 },
      { name: "OrderShippedC", value: 3 },
      { name: "OrderDeliveredC", value: 4 },
    ]);
  });

  it("reads a block of explicit values, including strings", () => {
    const sets = valueSetsIn(
      "svc",
      "constant/tables.go",
      `package constant

const (
	TableOrder TableName = "shop_order"
	TableItem  TableName = "shop_item"
)
`,
    );

    expect(sets[0]!.members).toEqual([
      { name: "TableOrder", value: "shop_order" },
      { name: "TableItem", value: "shop_item" },
    ]);
  });

  it("ignores a block with a single member, which names nothing", () => {
    expect(valueSetsIn("svc", "c.go", "package c\n\nconst (\n\tOnly = 1\n)\n")).toEqual([]);
  });
});

describe("valueSetsIn — TypeScript and JavaScript", () => {
  it("reads a const object of primitives", () => {
    const sets = valueSetsIn(
      "api",
      "common/types.js",
      "const OrderStatus = { draft: 1, placed: 2, shipped: 3 };\n",
    );

    expect(sets[0]!.name).toBe("OrderStatus");
    expect(sets[0]!.members).toHaveLength(3);
  });

  it("reads a TypeScript enum, numbering members with no initializer", () => {
    const sets = valueSetsIn("api", "types.ts", "enum Colour { Red, Green, Blue }\n");
    expect(sets[0]!.members.map((member) => member.value)).toEqual([0, 1, 2]);
  });

  it("ignores an object whose values are not constants", () => {
    expect(valueSetsIn("api", "x.ts", "const handlers = { a: doThing, b: other };\n")).toEqual([]);
  });
});

describe("resolveValue", () => {
  const sets = valueSetsIn(
    "svc",
    "c.go",
    `package c

const (
	OrderDraftC OrderStatusC = iota + 1
	OrderPlacedC
	OrderShippedC
)

const (
	PaymentPendingC PaymentStatusC = iota + 1
	PaymentSettledC
)
`,
  );

  it("names a value from the set its subject agrees with", () => {
    expect(resolveValue("order.Status", 2, sets)?.member.name).toBe("OrderPlacedC");
  });

  it("prefers the set whose name carries no token the subject lacks", () => {
    // Both sets share "status"; only the extra "payment" separates them.
    expect(resolveValue("payment.Status", 2, sets)?.set.name).toBe("PaymentStatusC");
    expect(resolveValue("order.Status", 1, sets)?.set.name).toBe("OrderStatusC");
  });

  it("refuses a set that shares a name but cannot explain the value", () => {
    expect(resolveValue("order.Status", 99, sets)).toBeNull();
  });

  it("refuses a set that explains the value but shares no name", () => {
    expect(resolveValue("retries", 2, sets)).toBeNull();
  });

  it("picks one set for wording a range, never mixing two vocabularies", () => {
    expect(bestSetFor("order.Status", sets)?.name).toBe("OrderStatusC");
    expect(bestSetFor("payment.Status", sets)?.name).toBe("PaymentStatusC");
    expect(bestSetFor("retries", sets)).toBeNull();
  });
});

describe("nameTokens", () => {
  it("splits any convention into lowercase words", () => {
    expect(nameTokens("LvStatusC")).toEqual(["lv", "status"]);
    expect(nameTokens("order_status")).toEqual(["order", "status"]);
    expect(nameTokens("orderStatus")).toEqual(["order", "status"]);
  });
});

describe("commonTablePrefix", () => {
  it("finds the namespace a project puts on its own tables", () => {
    // Whatever it spells — the point is that most tables share it.
    expect(
      commonTablePrefix(["shop_order", "shop_item", "shop_user", "shop_cart", "audit_log"]),
    ).toBe("shop_");
  });

  it("returns nothing when tables share no prefix", () => {
    expect(commonTablePrefix(["orders", "items", "users", "carts", "logs"])).toBeNull();
  });

  it("returns nothing for too few tables to establish a convention", () => {
    expect(commonTablePrefix(["shop_order", "shop_item"])).toBeNull();
  });
});
