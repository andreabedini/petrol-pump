// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.

import { Cell, CellLoop, Stream, StreamLoop, StreamSink, Transaction, Unit } from "sodiumjs";

/* ui */

function sLabel(elementId: string, content: Cell<string>) {
  const el = document.getElementById(elementId) as HTMLElement;
  content.listen(s => {
    if (s === "") {
      el.innerHTML = "&nbsp;";
    } else {
      el.textContent = s;
    }
  });
}

function sButton(elementId: string) {
  const ss: StreamSink<Unit> = new StreamSink();
  const el = document.getElementById(elementId) as HTMLElement;
  el.onclick = (e) => ss.send(e);
  return ss;
}

/* helpers */

function accumulate(
  sClearAccumulator: Stream<Unit>,
  sPulses: Stream<number>,
  calibration: Cell<number>,
) {
  const total = new CellLoop<number>();
  total.loop(
    sClearAccumulator.map(() => 0)
      .orElse(
        sPulses.snapshot(total, (pulses, total) => pulses + total),
      )
      .hold(0),
  );
  return total.lift(calibration, (total, calibration) => total * calibration);
}

enum Fuel { One = 1, Two, Three }
enum Delivery { Off, Fast1, Fast2, Fast3 }
enum UpDown { Up, Down }
enum End { End }

interface Inputs {
  sNozzle1: Stream<UpDown>;
  sNozzle2: Stream<UpDown>;
  sNozzle3: Stream<UpDown>;
  sFuelPulses: Stream<number>;
  calibration: Cell<number>;
  price1: Cell<number>;
  price2: Cell<number>;
  price3: Cell<number>;
  sClearSale: Stream<Unit>;
  sKeypad: Stream<string>;
}

interface Outputs {
  delivery: Cell<Delivery>;
  presetLCD: Cell<string>;
  saleCostLCD: Cell<string>;
  saleQuantityLCD: Cell<string>;
  priceLCD1: Cell<string>;
  priceLCD2: Cell<string>;
  priceLCD3: Cell<string>;
  sSaleComplete: Stream<string>;
}

main();

function main() {
  const calibration = new Cell(1.0);
  const price1 = new Cell(2.149);
  const price2 = new Cell(2.341);
  const price3 = new Cell(1.499);
  const sFuelPulses = new Stream<number>();
  const sClearSale = new StreamSink<Unit>();

  /* Nozzles */
  const sNozzle1 = sButton("nozzle1up")
    .map(() => UpDown.Up)
    .orElse(sButton("nozzle1down")
      .map(() => UpDown.Down));

  const sNozzle2 = sButton("nozzle2up")
    .map(() => UpDown.Up)
    .orElse(sButton("nozzle2down")
      .map(() => UpDown.Down));

  const sNozzle3 = sButton("nozzle3up")
    .map(() => UpDown.Up)
    .orElse(sButton("nozzle3down")
      .map(() => UpDown.Down));

  /* Keypad */
  const sKeypad =
    sButton("keypad1").map((e) => "1")
      .orElse(sButton("keypad2").map((e) => "2"))
      .orElse(sButton("keypad3").map((e) => "3"))
      .orElse(sButton("keypad4").map((e) => "4"))
      .orElse(sButton("keypad5").map((e) => "5"))
      .orElse(sButton("keypad6").map((e) => "6"))
      .orElse(sButton("keypad7").map((e) => "7"))
      .orElse(sButton("keypad8").map((e) => "8"))
      .orElse(sButton("keypad9").map((e) => "9"))
      .orElse(sButton("keypad0").map((e) => "0"))
      .orElse(sButton("keypadR").map((e) => "R"));

  const { presetLCD, saleCostLCD, saleQuantityLCD, priceLCD1, priceLCD2, priceLCD3, sSaleComplete } =
    Transaction.run(() =>
      build({ sNozzle1, sNozzle2, sNozzle3, sFuelPulses, calibration, price1, price2, price3, sClearSale, sKeypad })
    );

  /*
  * Outputs
  */

  sLabel("presetLCD", presetLCD);
  sLabel("saleQuantityLCD", saleQuantityLCD);
  sLabel("saleCostLCD", saleCostLCD);
  sLabel("priceLCD1", priceLCD1);
  sLabel("priceLCD2", priceLCD2);
  sLabel("priceLCD3", priceLCD3);

  sSaleComplete.listen(sale => {
    const result = window.confirm(sale);
    if (result) {
      setTimeout(() => sClearSale.send(new Unit()), 0);
    }
  });

}

function build(inputs: Inputs): Outputs {
  const sStart = new StreamLoop<Fuel>();

  const fi =
    Fill(
      sStart.map(() => new Unit()),
      inputs.sFuelPulses,
      inputs.calibration,
      inputs.price1,
      inputs.price2,
      inputs.price3,
      sStart);

  const np = NotifyPointOfSale(
    LifeCycle(
      inputs.sNozzle1,
      inputs.sNozzle2,
      inputs.sNozzle3),
    inputs.sClearSale,
    fi);

  sStart.loop(np.sStart);

  const delivery = np.fillActive.map(fuelType => {
    switch (fuelType) {
      case Fuel.One:
        return Delivery.Fast1;
      case Fuel.Two:
        return Delivery.Fast2;
      case Fuel.Three:
        return Delivery.Fast3;
      default:
        return Delivery.Off;
    }
  });

  const saleCostLCD = fi.dollarsDelivered.map(s => s.toString());
  const saleQuantityLCD = fi.litersDelivered.map(s => s.toString());
  const priceLCD1 = priceLCD(np.fillActive, fi.price, inputs.price1, Fuel.One);
  const priceLCD2 = priceLCD(np.fillActive, fi.price, inputs.price2, Fuel.Two);
  const priceLCD3 = priceLCD(np.fillActive, fi.price, inputs.price3, Fuel.Three);

  const keypad = Keypad(inputs.sKeypad, new Stream<Unit>());
  const presetLCD = keypad.value.map(n => n.toString());

  return {
    delivery, presetLCD, saleCostLCD, saleQuantityLCD, priceLCD1, priceLCD2, priceLCD3,
    sSaleComplete: np.sSaleComplete
  };
}

function Keypad(
  sKeypad: Stream<string>,
  sClear: Stream<Unit>
) {
  const value = new CellLoop<number>();

  const sKeyUpdate =
    sKeypad.snapshot(value, (k, v) => {
      if (k === "R") { return 0; } else {
        const x10 = v * 10;
        return x10 >= 1000 ? null :
          k === "0" ? x10 :
            k === "1" ? x10 + 1 :
              k === "2" ? x10 + 2 :
                k === "3" ? x10 + 3 :
                  k === "4" ? x10 + 4 :
                    k === "5" ? x10 + 5 :
                      k === "6" ? x10 + 6 :
                        k === "7" ? x10 + 7 :
                          k === "8" ? x10 + 8 : x10 + 9;
      }
    }).filterNotNull() as Stream<number>;

  value.loop(sKeyUpdate.orElse(sClear.map(() => 0)).hold(0));

  const sBeep = sKeyUpdate.map(() => new Unit());

  return { value, sBeep };
}

function NotifyPointOfSale(
  lc: { fillActive: CellLoop<Fuel | null>, sStart: Stream<Fuel>, sEnd: Stream<End> },
  sClearSale: Stream<Unit>,
  fi: { price: Cell<number>, litersDelivered: Cell<number>, dollarsDelivered: Cell<number> }
) {
  enum Phase { Idle, Filling, Pos }

  const phase = new CellLoop<Phase>();

  const sStart = lc.sStart.gate(phase.map(p => p === Phase.Idle));
  const sEnd = lc.sEnd.gate(phase.map(p => p === Phase.Filling));

  const fuelFlowing =
    sStart
      .map(f => f as Fuel | null)
      .orElse(
        sEnd.map(() => null as Fuel | null)
      )
      .hold(null);

  const fillActive =
    sStart
      .map(f => f as Fuel | null)
      .orElse(
        sClearSale.map(() => null as Fuel | null)
      )
      .hold(null);

  const sBeep = sClearSale;

  const sSaleComplete =
    sEnd.snapshot(
      fuelFlowing.lift4(fi.price, fi.dollarsDelivered, fi.litersDelivered,
        (f, p, d, l) => {
          if (f !== null) {
            return `new Sale: fuel ${f}, price ${p}, dollars: ${d}, liters: ${l}`;
          } else {
            return null;
          }
        }), (e, sale) => sale)
      .filterNotNull() as Stream<string>;

  phase.loop(
    sStart.map(() => Phase.Filling)
      .orElse(sEnd.map(() => Phase.Pos))
      .orElse(sClearSale.map(() => Phase.Idle))
      .hold(Phase.Idle)
  );

  return { sStart, sEnd, fillActive, fuelFlowing, sBeep, sSaleComplete };
}

function LifeCycle(
  sNozzle1: Stream<UpDown>,
  sNozzle2: Stream<UpDown>,
  sNozzle3: Stream<UpDown>
) {
  const fillActive = new CellLoop<Fuel | null>();

  const sLiftNozzle =
    whenLifted(sNozzle1, Fuel.One)
      .orElse(
        whenLifted(sNozzle2, Fuel.Two)
      ).orElse(
        whenLifted(sNozzle3, Fuel.Three)
      );

  const sStart =
    sLiftNozzle.gate(fillActive.map(active => active === null));

  const sEnd =
    whenSetDown(sNozzle1, Fuel.One, fillActive)
      .orElse(
        whenSetDown(sNozzle2, Fuel.Two, fillActive)
      ).orElse(
        whenSetDown(sNozzle3, Fuel.Three, fillActive)
      );

  fillActive.loop(
    sEnd.map(e => null as Fuel | null)
      .orElse(sStart.map(f => f as Fuel | null))
      .hold(null)
  );

  return { fillActive, sStart, sEnd };
}

function whenLifted(
  sNozzle: Stream<UpDown>,
  fuel: Fuel
): Stream<Fuel> {
  return sNozzle.filter(u => u === UpDown.Up).map(() => fuel);
}

function whenSetDown(
  sNozzle: Stream<UpDown>,
  fuel: Fuel,
  fillActive: Cell<Fuel | null>
) {
  return sNozzle
    .gate(fillActive.map(fuelType => fuelType === fuel))
    .filter(u => u === UpDown.Down).map(() => fuel)
    .map(() => End.End);
}

function Fill(
  sClearAccumulator: Stream<Unit>,
  sFuelPulses: Stream<number>,
  calibration: Cell<number>,
  price1: Cell<number>,
  price2: Cell<number>,
  price3: Cell<number>,
  sStart: Stream<Fuel>
) {
  const price = capturePrice(sStart, price1, price2, price3);
  const litersDelivered = accumulate(sClearAccumulator, sFuelPulses, calibration);
  const dollarsDelivered = litersDelivered.lift(price, (liters, price) => liters * price);
  return { price, litersDelivered, dollarsDelivered };
}

function capturePrice(
  sStart: Stream<Fuel>,
  price1: Cell<number>,
  price2: Cell<number>,
  price3: Cell<number>,
): Cell<number> {
  const sPrice1 =
    sStart
      .snapshot(price1, (f, p) => f === Fuel.One ? p : null)
      .filterNotNull() as Stream<number>;

  const sPrice2 =
    sStart
      .snapshot(price2, (f, p) => f === Fuel.Two ? p : null)
      .filterNotNull() as Stream<number>;

  const sPrice3 =
    sStart
      .snapshot(price3, (f, p) => f === Fuel.Three ? p : null)
      .filterNotNull() as Stream<number>;

  return sPrice1.orElse(sPrice2).orElse(sPrice3).hold(0);
}

function priceLCD(
  fillActive: Cell<Fuel | null>,
  fillPrice: Cell<number>,
  idlePrice: Cell<number>,
  fuel: Fuel
) {
  const r = fillActive.lift3(fillPrice, idlePrice,
    (active, price, idle) => {
      if (active === null) {
        return idle.toString();
      } else if (active === fuel) {
        return price.toString();
      } else {
        return "";
      }
    });
  return r;
}
