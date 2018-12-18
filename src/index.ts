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

enum Delivery { Off, Fast1, Fast2, Fast3, Slow1, Slow2, Slow3 }
enum End { End }
enum Fuel { One = 1, Two, Three }
enum Phase { Idle, Filling, Pos }
enum Speed { Fast, Slow, Stopped }
enum UpDown { Up, Down }

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
  sBeep: Stream<Unit>;
}

class LifeCycle {
  sStart: Stream<Fuel>;
  sEnd: Stream<End>;
  fillActive: CellLoop<Fuel | null>;

  constructor(
    sNozzle1: Stream<UpDown>,
    sNozzle2: Stream<UpDown>,
    sNozzle3: Stream<UpDown>
  ) {
    this.fillActive = new CellLoop<Fuel | null>();

    const sLiftNozzle =
      this.whenLifted(sNozzle1, Fuel.One)
        .orElse(
          this.whenLifted(sNozzle2, Fuel.Two)
        ).orElse(
          this.whenLifted(sNozzle3, Fuel.Three)
        );

    this.sStart =
      sLiftNozzle.gate(this.fillActive.map(active => active === null));

    this.sEnd =
      this.whenSetDown(sNozzle1, Fuel.One, this.fillActive)
        .orElse(
          this.whenSetDown(sNozzle2, Fuel.Two, this.fillActive)
        ).orElse(
          this.whenSetDown(sNozzle3, Fuel.Three, this.fillActive)
        );

    this.fillActive.loop(
      this.sEnd.map(e => null as Fuel | null)
        .orElse(this.sStart.map(f => f as Fuel | null))
        .hold(null)
    );
  }

  whenLifted(
    sNozzle: Stream<UpDown>,
    fuel: Fuel
  ): Stream<Fuel> {
    return sNozzle.filter(u => u === UpDown.Up).map(() => fuel);
  }

  whenSetDown(
    sNozzle: Stream<UpDown>,
    fuel: Fuel,
    fillActive: Cell<Fuel | null>
  ) {
    return sNozzle
      .gate(fillActive.map(fuelType => fuelType === fuel))
      .filter(u => u === UpDown.Down).map(() => fuel)
      .map(() => End.End);
  }
}

class Fill {
  readonly price: Cell<number>;
  readonly litersDelivered: Cell<number>;
  readonly dollarsDelivered: Cell<number>;

  constructor(
    sClearAccumulator: Stream<Unit>,
    sFuelPulses: Stream<number>,
    calibration: Cell<number>,
    price1: Cell<number>,
    price2: Cell<number>,
    price3: Cell<number>,
    sStart: Stream<Fuel>
  ) {
    this.price = this.capturePrice(sStart, price1, price2, price3);
    this.litersDelivered = this.accumulate(sClearAccumulator, sFuelPulses, calibration);
    this.dollarsDelivered = this.litersDelivered.lift(this.price, (liters, price) => liters * price);
  }

  capturePrice(
    sStart: Stream<Fuel>,
    price1: Cell<number>,
    price2: Cell<number>,
    price3: Cell<number>
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

  accumulate(
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
}

class NotifyPointOfSale {
  readonly sStart: Stream<Fuel>;
  readonly fillActive: Cell<Fuel | null>;
  readonly fuelFlowing: Cell<Fuel | null>;

  readonly sEnd: Stream<End>;
  readonly sBeep: Stream<Unit>;
  readonly sSaleComplete: Stream<string>;

  constructor(lc: LifeCycle, sClearSale: Stream<Unit>, fi: Fill) {
    const phase = new CellLoop<Phase>();

    this.sStart = lc.sStart.gate(phase.map(p => p === Phase.Idle));
    this.sEnd = lc.sEnd.gate(phase.map(p => p === Phase.Filling));

    this.fillActive =
      this.sStart
        .map(f => f as Fuel | null)
        .orElse(
          sClearSale.map(() => null as Fuel | null)
        )
        .hold(null);

    this.fuelFlowing =
      this.sStart
        .map(f => f as Fuel | null)
        .orElse(
          this.sEnd.map(() => null as Fuel | null)
        )
        .hold(null);

    this.sBeep = sClearSale;

    this.sSaleComplete =
      this.sEnd.snapshot(
        this.fuelFlowing.lift4(fi.price, fi.dollarsDelivered, fi.litersDelivered,
          (f, p, d, l) => {
            if (f !== null) {
              return `new Sale: fuel ${f}, price ${p}, dollars: ${d}, liters: ${l}`;
            } else {
              return null;
            }
          }), (e, sale) => sale)
        .filterNotNull() as Stream<string>;

    phase.loop(
      this.sStart.map(() => Phase.Filling)
        .orElse(this.sEnd.map(() => Phase.Pos))
        .orElse(sClearSale.map(() => Phase.Idle))
        .hold(Phase.Idle)
    );
  }
}

class Keypad {
  readonly value: CellLoop<number>;
  readonly sBeep: Stream<Unit>;

  constructor(
    sKeypad: Stream<string>,
    sClear: Stream<Unit>,
    active: Cell<boolean> = new Cell(true)
  ) {
    this.value = new CellLoop<number>();

    const sKeyUpdate =
      sKeypad
        .gate(active)
        .snapshot(this.value, (k, v) => {
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

    this.value.loop(sKeyUpdate.orElse(sClear.map(() => 0)).hold(0));
    this.sBeep = sKeyUpdate.map(() => new Unit());
  }
}

class Preset {
  readonly delivery: Cell<Delivery>
  readonly keypadActive: Cell<boolean>

  constructor(
    presetDollars: Cell<number>,
    fi: Fill,
    fuelFlowing: Cell<Fuel | null>
  ) {
    const speed = presetDollars.lift4(
      fi.price, fi.dollarsDelivered, fi.litersDelivered,
      (presetDollars, price, dollarsDelivered, litersDelivered) => {
        if (presetDollars === 0) {
          return Speed.Fast
        } else {
          if (dollarsDelivered >= presetDollars)
            return Speed.Stopped

          const slowDollars = presetDollars - 5
          if (dollarsDelivered >= slowDollars)
            return Speed.Slow;
          else
            return Speed.Fast;
        }
      }
    )

    this.delivery = fuelFlowing.lift(speed,
      (fuel, speed) =>
        speed === Speed.Fast ? (
          fuel === Fuel.One ? Delivery.Fast1 :
            fuel === Fuel.Two ? Delivery.Fast2 :
              fuel === Fuel.Three ? Delivery.Fast3 :
                Delivery.Off
        ) :
          speed === Speed.Slow ? (
            fuel === Fuel.One ? Delivery.Slow1 :
              fuel === Fuel.Two ? Delivery.Slow2 :
                fuel === Fuel.Three ? Delivery.Slow3 :
                  Delivery.Off
          ) :
            Delivery.Off
    )

    this.keypadActive = fuelFlowing.lift(speed,
      (fuel, speed) => fuel === null || speed === Speed.Fast)
  }
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

function build(inputs: Inputs): Outputs {
  const sStart = new StreamLoop<Fuel>();

  const fi = new Fill(
    sStart.map(() => new Unit()), inputs.sFuelPulses, inputs.calibration,
    inputs.price1, inputs.price2, inputs.price3, sStart);

  const np = new NotifyPointOfSale(
    new LifeCycle(inputs.sNozzle1, inputs.sNozzle2, inputs.sNozzle3),
    inputs.sClearSale, fi);

  sStart.loop(np.sStart);

  const priceLCD1 = priceLCD(np.fillActive, fi.price, inputs.price1, Fuel.One);
  const priceLCD2 = priceLCD(np.fillActive, fi.price, inputs.price2, Fuel.Two);
  const priceLCD3 = priceLCD(np.fillActive, fi.price, inputs.price3, Fuel.Three);

  const keypadActive = new CellLoop<boolean>()

  const ke = new Keypad(
    inputs.sKeypad,
    inputs.sClearSale,
    keypadActive
  );

  fi.price.listen(console.log)

  const pr = new Preset(
    ke.value,
    fi,
    np.fuelFlowing
  )

  keypadActive.loop(pr.keypadActive)

  return {
    delivery: pr.delivery,
    presetLCD: ke.value.map(s => s.toString()),
    saleCostLCD: fi.dollarsDelivered.map(s => s.toString()),
    saleQuantityLCD: fi.litersDelivered.map(s => s.toString()),
    priceLCD1, priceLCD2, priceLCD3,
    sSaleComplete: np.sSaleComplete,
    sBeep: np.sBeep.orElse(ke.sBeep)
  };
}


function main() {
  const delivery = new CellLoop<Delivery>()

  const inputs = {
    calibration: new Cell(1.0),
    price1: new Cell(2.149),
    price2: new Cell(2.341),
    price3: new Cell(1.499),

    sFuelPulses: sButton("pulse1").map(e => 0.1)
      .orElse(sButton("pulse5").map(e => 1))
      .orElse(sButton("pulse10").map(e => 5))
      .gate(delivery.map(d => d !== Delivery.Off)),

    sClearSale: sButton("clearSale"),

    /* Nozzles */
    sNozzle1: sButton("nozzle1up")
      .map(() => UpDown.Up)
      .orElse(sButton("nozzle1down")
        .map(() => UpDown.Down)),

    sNozzle2: sButton("nozzle2up")
      .map(() => UpDown.Up)
      .orElse(sButton("nozzle2down")
        .map(() => UpDown.Down)),

    sNozzle3: sButton("nozzle3up")
      .map(() => UpDown.Up)
      .orElse(sButton("nozzle3down")
        .map(() => UpDown.Down)),

    sKeypad: sButton("keypad1").map(e => "1")
      .orElse(sButton("keypad2").map(e => "2"))
      .orElse(sButton("keypad3").map(e => "3"))
      .orElse(sButton("keypad4").map(e => "4"))
      .orElse(sButton("keypad5").map(e => "5"))
      .orElse(sButton("keypad6").map(e => "6"))
      .orElse(sButton("keypad7").map(e => "7"))
      .orElse(sButton("keypad8").map(e => "8"))
      .orElse(sButton("keypad9").map(e => "9"))
      .orElse(sButton("keypad0").map(e => "0"))
      .orElse(sButton("keypadR").map(e => "R"))
  }

  const outputs = build(inputs);

  const {
    presetLCD, saleCostLCD, saleQuantityLCD, priceLCD1, priceLCD2, priceLCD3,
    sSaleComplete
  } = outputs

  delivery.loop(outputs.delivery)

  /*
  * Outputs
  */

  sLabel("presetLCD", presetLCD);
  sLabel("saleQuantityLCD", saleQuantityLCD);
  sLabel("saleCostLCD", saleCostLCD);
  sLabel("priceLCD1", priceLCD1);
  sLabel("priceLCD2", priceLCD2);
  sLabel("priceLCD3", priceLCD3);

  sSaleComplete.listen(sale => window.confirm(
    `${sale}\nClick "clear sale" after accepting payment.`
  ));

  const deliveryMsg = {
    [Delivery.Off]: "Off",
    [Delivery.Fast1]: "Fast1",
    [Delivery.Fast2]: "Fast2",
    [Delivery.Fast3]: "Fast3",
    [Delivery.Slow1]: "Slow1",
    [Delivery.Slow2]: "Slow2",
    [Delivery.Slow3]: "Slow3",
  }

  sLabel("delivery", delivery.map(d => `delivery: ${deliveryMsg[d]}`))
}

Transaction.run(main)
