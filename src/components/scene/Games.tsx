import { useCallback, useEffect, useRef, useState } from 'react';

import { resolvePalette } from '@/components/scene/palette';

/**
 * The two things in the corner you can actually play.
 *
 * Both are drawn on a canvas in the current theme's colours, for the reason
 * every other generated thing in this app is: a toy that ignores the look the
 * user chose is a toy sitting on their app rather than in it.
 *
 * ## Keyboard, carefully
 *
 * A game in the corner of a chat app must never eat a keystroke meant for the
 * message box. Both of these listen only while focused — the canvas is
 * focusable and the handler is on the element, not on the window — so the arrow
 * keys belong to the game exactly when the user has clicked into it, and to the
 * conversation the rest of the time. Clicking away hands them straight back.
 */

/** Cells across and down. Small enough that a corner card is a fair board. */
const GRID = 16;
/** How long a snake step takes, in ms. Slow enough to be playable at this size. */
const STEP_MS = 130;

type Point = { x: number; y: number };

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

function useCanvasSize(ref: React.RefObject<HTMLCanvasElement | null>): void {
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;

    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      const ctx = canvas.getContext('2d');
      ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    return () => observer.disconnect();
  }, [ref]);
}

export function Snake() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [dead, setDead] = useState(false);
  useCanvasSize(canvasRef);

  /*
    The game state lives in refs, not in state.

    It changes on a timer several times a second and only the score and the
    game-over banner are worth a render; keeping the snake in `useState` would
    re-render the whole card every step to redraw a canvas that is drawn
    imperatively anyway.
  */
  const snake = useRef<Point[]>([{ x: 8, y: 8 }]);
  const heading = useRef<Point>({ x: 1, y: 0 });
  /** The direction the last step was actually taken in. See the reversal guard. */
  const moved = useRef<Point>({ x: 1, y: 0 });
  const food = useRef<Point>({ x: 12, y: 8 });
  const over = useRef(false);

  const reset = useCallback(() => {
    snake.current = [{ x: 8, y: 8 }];
    heading.current = { x: 1, y: 0 };
    moved.current = { x: 1, y: 0 };
    food.current = { x: 12, y: 8 };
    over.current = false;
    setScore(0);
    setDead(false);
  }, []);

  const steer = useCallback((x: number, y: number) => {
    // Against the *last step taken*, not against the pending heading: two turns
    // inside one step would otherwise let a snake reverse into itself, which
    // reads as dying for no reason.
    if (moved.current.x === -x && moved.current.y === -y) return;
    heading.current = { x, y };
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const moves: Record<string, [number, number]> = {
      arrowup: [0, -1], w: [0, -1],
      arrowdown: [0, 1], s: [0, 1],
      arrowleft: [-1, 0], a: [-1, 0],
      arrowright: [1, 0], d: [1, 0],
    };
    if (key === 'enter' || key === ' ') {
      if (over.current) reset();
      event.preventDefault();
      return;
    }
    const move = moves[key];
    if (!move) return;
    // Only once it is definitely ours: the arrow keys scroll a page, and a game
    // that swallows them without using them is worse than one that ignores them.
    event.preventDefault();
    steer(move[0], move[1]);
  }, [steer, reset]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;

    const paint = () => {
      const palette = resolvePalette('theme');
      const rect = canvas.getBoundingClientRect();
      const cell = Math.min(rect.width, rect.height) / GRID;
      const offsetX = (rect.width - cell * GRID) / 2;
      const offsetY = (rect.height - cell * GRID) / 2;

      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = palette.far;
      ctx.fillRect(offsetX, offsetY, cell * GRID, cell * GRID);
      ctx.globalAlpha = 1;

      ctx.fillStyle = palette.accent;
      ctx.fillRect(offsetX + food.current.x * cell + 1, offsetY + food.current.y * cell + 1, cell - 2, cell - 2);

      snake.current.forEach((part, index) => {
        // The head solid, the body fading back, so which end is which is
        // readable at sixteen pixels a cell.
        ctx.globalAlpha = index === 0 ? 1 : Math.max(0.35, 1 - index / (snake.current.length + 4));
        ctx.fillStyle = index === 0 ? palette.ink : palette.near;
        ctx.fillRect(offsetX + part.x * cell + 1, offsetY + part.y * cell + 1, cell - 2, cell - 2);
      });
      ctx.globalAlpha = 1;
    };

    const step = () => {
      if (over.current) return;
      const head = snake.current[0];
      const next = { x: head.x + heading.current.x, y: head.y + heading.current.y };
      moved.current = heading.current;

      const hitWall = next.x < 0 || next.y < 0 || next.x >= GRID || next.y >= GRID;
      if (hitWall || snake.current.some((part) => same(part, next))) {
        over.current = true;
        setDead(true);
        return;
      }

      const ate = same(next, food.current);
      snake.current = [next, ...(ate ? snake.current : snake.current.slice(0, -1))];

      if (ate) {
        setScore((current) => current + 1);
        // Anywhere that is not the snake. A loop rather than a filtered list of
        // free cells, because the board is small and the snake rarely fills it.
        let spot: Point;
        do {
          spot = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
        } while (snake.current.some((part) => same(part, spot)));
        food.current = spot;
      }
    };

    const timer = window.setInterval(() => { step(); paint(); }, STEP_MS);
    paint();
    return () => window.clearInterval(timer);
  }, [dead]);

  return (
    <div className="flex h-full flex-col">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label="Snake. Click to play, then use the arrow keys."
        className="min-h-0 flex-1 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      />
      <div className="flex items-center justify-between px-2 pb-1 text-[11px] text-muted-foreground">
        <span>{dead ? 'Enter to try again' : 'Click, then arrow keys'}</span>
        <span className="tabular-nums">{score}</span>
      </div>
    </div>
  );
}

export function Pong() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState({ you: 0, them: 0 });
  useCanvasSize(canvasRef);

  const paddle = useRef(0.5);
  const opponent = useRef(0.5);
  const ball = useRef({ x: 0.5, y: 0.5, vx: 0.45, vy: 0.28 });

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (key !== 'arrowup' && key !== 'arrowdown' && key !== 'w' && key !== 's') return;
    event.preventDefault();
    const up = key === 'arrowup' || key === 'w';
    paddle.current = Math.min(0.9, Math.max(0.1, paddle.current + (up ? -0.08 : 0.08)));
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    paddle.current = Math.min(0.9, Math.max(0.1, (event.clientY - rect.top) / rect.height));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;

    let frame = 0;
    let last = performance.now();

    const loop = (now: number) => {
      // Clamped, so a window that was in the background does not resume with
      // the ball several screens past the paddle.
      const elapsed = Math.min(0.05, (now - last) / 1000);
      last = now;

      const state = ball.current;
      state.x += state.vx * elapsed;
      state.y += state.vy * elapsed;

      if (state.y < 0.02 || state.y > 0.98) state.vy *= -1;

      /*
        The opponent, deliberately imperfect.

        It tracks the ball at a fixed rate rather than teleporting to it, which
        is what makes the game winnable — a paddle that is always exactly right
        is not an opponent, it is a wall.
      */
      opponent.current += Math.sign(state.y - opponent.current) * Math.min(0.55 * elapsed, Math.abs(state.y - opponent.current));

      const hits = (at: number) => Math.abs(state.y - at) < 0.14;
      if (state.x < 0.05 && state.vx < 0) {
        if (hits(paddle.current)) {
          state.vx = Math.abs(state.vx) * 1.04;
          // Where it struck the paddle decides the angle, so the player has a
          // way to aim rather than only to survive.
          state.vy += (state.y - paddle.current) * 1.6;
        } else {
          setScore((current) => ({ ...current, them: current.them + 1 }));
          ball.current = { x: 0.5, y: 0.5, vx: 0.45, vy: 0.28 };
        }
      }
      if (state.x > 0.95 && state.vx > 0) {
        if (hits(opponent.current)) {
          state.vx = -Math.abs(state.vx) * 1.04;
          state.vy += (state.y - opponent.current) * 1.6;
        } else {
          setScore((current) => ({ ...current, you: current.you + 1 }));
          ball.current = { x: 0.5, y: 0.5, vx: -0.45, vy: -0.28 };
        }
      }

      const palette = resolvePalette('theme');
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);

      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = palette.far;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(rect.width / 2, 0);
      ctx.lineTo(rect.width / 2, rect.height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      const paddleHeight = rect.height * 0.28;
      ctx.fillStyle = palette.ink;
      ctx.fillRect(rect.width * 0.03, paddle.current * rect.height - paddleHeight / 2, 4, paddleHeight);
      ctx.fillStyle = palette.near;
      ctx.fillRect(rect.width * 0.97 - 4, opponent.current * rect.height - paddleHeight / 2, 4, paddleHeight);

      ctx.fillStyle = palette.accent;
      ctx.beginPath();
      ctx.arc(state.x * rect.width, state.y * rect.height, 4, 0, Math.PI * 2);
      ctx.fill();

      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerMove={onPointerMove}
        aria-label="Pong. Move the mouse, or click and use the arrow keys."
        className="min-h-0 flex-1 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      />
      <div className="flex items-center justify-between px-2 pb-1 text-[11px] text-muted-foreground">
        <span>Mouse, or arrow keys</span>
        <span className="tabular-nums">{score.you} — {score.them}</span>
      </div>
    </div>
  );
}
