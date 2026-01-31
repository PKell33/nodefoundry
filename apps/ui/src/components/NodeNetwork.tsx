import { useRef, useEffect, useCallback } from 'react';

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  isAccent: boolean;
  isDragged: boolean;
  targetAngle: number;
  angleChangeTimer: number;
}

const CONNECTION_DISTANCE = 150;
const PULL_STRENGTH = 0.02;
const DAMPING = 0.98;
const MAX_VELOCITY = 0.4;
const BASE_DRIFT = 0.05;

const COLORS = {
  node: '#c0caf5',
  accent: '#7aa2f7',
  connection: 'rgba(192, 202, 245, 0.15)',
};

export function NodeNetwork() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const animationRef = useRef<number>(0);
  const draggedNodeRef = useRef<Node | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });

  const initNodes = useCallback((width: number, height: number) => {
    const area = width * height;
    const count = Math.floor(area / 15000);
    const nodes: Node[] = [];

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = BASE_DRIFT * (0.5 + Math.random() * 0.5);
      nodes.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 3 + Math.random() * 2,
        isAccent: Math.random() < 0.15,
        isDragged: false,
        targetAngle: angle,
        angleChangeTimer: Math.random() * 200 + 100,
      });
    }

    nodesRef.current = nodes;
  }, []);

  const updateNodes = useCallback((width: number, height: number) => {
    const nodes = nodesRef.current;
    const draggedNode = draggedNodeRef.current;

    for (const node of nodes) {
      if (node.isDragged) {
        // Dragged node follows mouse smoothly
        const targetX = mouseRef.current.x;
        const targetY = mouseRef.current.y;
        node.vx = (targetX - node.x) * 0.3;
        node.vy = (targetY - node.y) * 0.3;
        node.x += node.vx;
        node.y += node.vy;
        continue;
      }

      // Apply pull from dragged node to connected nodes
      if (draggedNode) {
        const dx = draggedNode.x - node.x;
        const dy = draggedNode.y - node.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < CONNECTION_DISTANCE * 1.5 && distance > 0) {
          const normalizedDist = distance / (CONNECTION_DISTANCE * 1.5);
          const force = PULL_STRENGTH * Math.pow(1 - normalizedDist, 2);
          node.vx += (dx / distance) * force * distance * 0.1;
          node.vy += (dy / distance) * force * distance * 0.1;
        }
      }

      // Smooth drift - gradually change direction
      node.angleChangeTimer--;
      if (node.angleChangeTimer <= 0) {
        const currentAngle = Math.atan2(node.vy, node.vx);
        node.targetAngle = currentAngle + (Math.random() - 0.5) * Math.PI * 0.5;
        node.angleChangeTimer = Math.random() * 300 + 150;
      }

      // Apply gentle drift force
      const driftForce = BASE_DRIFT * 0.05;
      node.vx += Math.cos(node.targetAngle) * driftForce;
      node.vy += Math.sin(node.targetAngle) * driftForce;

      // Apply damping
      node.vx *= DAMPING;
      node.vy *= DAMPING;

      // Clamp velocity
      const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (speed > MAX_VELOCITY) {
        node.vx = (node.vx / speed) * MAX_VELOCITY;
        node.vy = (node.vy / speed) * MAX_VELOCITY;
      }

      // Update position
      node.x += node.vx;
      node.y += node.vy;

      // Bounce off edges smoothly
      const margin = node.radius + 5;
      if (node.x < margin) {
        node.x = margin;
        node.vx = Math.abs(node.vx) * 0.5;
        node.targetAngle = Math.random() * Math.PI - Math.PI / 2;
      } else if (node.x > width - margin) {
        node.x = width - margin;
        node.vx = -Math.abs(node.vx) * 0.5;
        node.targetAngle = Math.random() * Math.PI + Math.PI / 2;
      }

      if (node.y < margin) {
        node.y = margin;
        node.vy = Math.abs(node.vy) * 0.5;
        node.targetAngle = Math.random() * Math.PI;
      } else if (node.y > height - margin) {
        node.y = height - margin;
        node.vy = -Math.abs(node.vy) * 0.5;
        node.targetAngle = -Math.random() * Math.PI;
      }
    }
  }, []);

  const draw = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const nodes = nodesRef.current;

    // Clear canvas
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, width, height);

    // Draw connections
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < CONNECTION_DISTANCE) {
          const opacity = 0.4 * Math.pow(1 - distance / CONNECTION_DISTANCE, 1.5);
          const lineWidth = 1.5 * (1 - distance / CONNECTION_DISTANCE) + 0.5;
          ctx.lineWidth = lineWidth;
          ctx.strokeStyle = `rgba(122, 162, 247, ${opacity})`;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.stroke();
        }
      }
    }

    // Draw nodes
    for (const node of nodes) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);

      if (node.isAccent) {
        // Accent node with glow
        ctx.fillStyle = COLORS.accent;
        ctx.shadowColor = COLORS.accent;
        ctx.shadowBlur = 10;
      } else {
        ctx.fillStyle = COLORS.node;
        ctx.shadowBlur = 0;
      }

      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }, []);

  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    updateNodes(width, height);
    draw(ctx, width, height);

    animationRef.current = requestAnimationFrame(animate);
  }, [updateNodes, draw]);

  const handleResize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    canvas.width = width;
    canvas.height = height;

    initNodes(width, height);
  }, [initNodes]);

  const findNodeAt = useCallback((x: number, y: number): Node | null => {
    const nodes = nodesRef.current;
    for (const node of nodes) {
      const dx = x - node.x;
      const dy = y - node.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < node.radius + 10) {
        return node;
      }
    }
    return null;
  }, []);

  const handleMouseDown = useCallback((e: MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    mouseRef.current = { x, y };

    const node = findNodeAt(x, y);
    if (node) {
      node.isDragged = true;
      draggedNodeRef.current = node;
    }
  }, [findNodeAt]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    mouseRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const handleMouseUp = useCallback(() => {
    if (draggedNodeRef.current) {
      draggedNodeRef.current.isDragged = false;
      // Give a small random velocity on release
      const angle = Math.random() * Math.PI * 2;
      draggedNodeRef.current.vx = Math.cos(angle) * BASE_DRIFT;
      draggedNodeRef.current.vy = Math.sin(angle) * BASE_DRIFT;
      draggedNodeRef.current = null;
    }
  }, []);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length === 0) return;
    const touch = e.touches[0];
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    mouseRef.current = { x, y };

    const node = findNodeAt(x, y);
    if (node) {
      node.isDragged = true;
      draggedNodeRef.current = node;
    }
  }, [findNodeAt]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (e.touches.length === 0) return;
    const touch = e.touches[0];
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    mouseRef.current = {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top,
    };
  }, []);

  const handleTouchEnd = useCallback(() => {
    handleMouseUp();
  }, [handleMouseUp]);

  useEffect(() => {
    handleResize();
    window.addEventListener('resize', handleResize);

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.addEventListener('mousedown', handleMouseDown);
      canvas.addEventListener('mousemove', handleMouseMove);
      canvas.addEventListener('mouseup', handleMouseUp);
      canvas.addEventListener('mouseleave', handleMouseUp);
      canvas.addEventListener('touchstart', handleTouchStart, { passive: true });
      canvas.addEventListener('touchmove', handleTouchMove, { passive: true });
      canvas.addEventListener('touchend', handleTouchEnd);
    }

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (canvas) {
        canvas.removeEventListener('mousedown', handleMouseDown);
        canvas.removeEventListener('mousemove', handleMouseMove);
        canvas.removeEventListener('mouseup', handleMouseUp);
        canvas.removeEventListener('mouseleave', handleMouseUp);
        canvas.removeEventListener('touchstart', handleTouchStart);
        canvas.removeEventListener('touchmove', handleTouchMove);
        canvas.removeEventListener('touchend', handleTouchEnd);
      }
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [handleResize, handleMouseDown, handleMouseMove, handleMouseUp, handleTouchStart, handleTouchMove, handleTouchEnd, animate]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full"
      style={{ touchAction: 'none' }}
    />
  );
}
