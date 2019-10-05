import { View } from "../src/apps/queries";
import { InMemStore } from "../src/store";

describe("LockStore", () => {
  it("counts sequentially", async () => {
    const store = new InMemStore();

    let val = 0;
    const count = () => store.lock('count', () => {
      val += 1;
      return Promise.resolve();
    })

    await Promise.all([
      count(),
      count(),
      count(),
      count(),
    ]);

    expect(val).toEqual(4);
  });
});

