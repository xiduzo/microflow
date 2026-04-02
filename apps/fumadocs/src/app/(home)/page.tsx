import Link from "next/link";
import {
  Cpu,
  Radio,
  Figma,
  Zap,
  Code2,
  Workflow,
  ChevronDown,
  Github,
  ArrowRight,
  PenTool,
} from "lucide-react";

const features = [
  {
    icon: Cpu,
    title: "Hardware",
    description:
      "Connect sensors, LEDs, servos, and other components to your microcontroller. Build interactions visually without writing code.",
  },
  {
    icon: Radio,
    title: "MQTT",
    description:
      "Integrate with IoT ecosystems using MQTT. Publish and subscribe to topics to connect your prototypes to the wider world.",
  },
  {
    icon: PenTool,
    title: "Design",
    description:
      "Bridge your designs with real hardware. Sync variables between your design prototypes and physical components. Fully supports Figma, penpot coming soon!",
  },
];

const highlights = [
  {
    icon: Zap,
    title: "Rapid prototyping",
    description:
      "Don't worry about low-level coding. Focus on creating engaging interactions and bringing your ideas to life quickly.",
  },
  {
    icon: Code2,
    title: "Open source",
    description:
      "Microflow is fully open-source. Contribute nodes, fix bugs, or fork it to make it your own.",
  },
  {
    icon: Workflow,
    title: "Visual flow editor",
    description:
      "Drag, drop, and connect nodes to build complex hardware interactions with an intuitive node-based interface.",
  },
];

const faqs = [
  {
    question: "Is Microflow free?",
    answer:
      "Yes, and we are committed to providing a free platform for all starters.",
  },
  {
    question: "My microcontroller does not connect, why?",
    answer:
      "We currently support Arduino Uno, Mega, Leonardo, Micro, Nano, and Yun boards.",
  },
  {
    question: "I found a bug, what should I do?",
    answer:
      "Create an issue on our GitHub repository so we are aware of the bug.",
  },
  {
    question: "My sensor is not supported, what can I do?",
    answer:
      "You can create a pull request on our GitHub repository to add support for it.",
  },
  {
    question: "How can I support this project?",
    answer:
      "Spread the word! Share Microflow with your friends and colleagues, and star our GitHub repository.",
  },
  {
    question: "You are awesome!",
    answer: "Not really a question, but thank you! You are awesome too ♥️",
  },
];

function Trace({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-0 opacity-30 ${className ?? ""}`}>
      <div className="h-px flex-1 bg-fd-primary" />
      <div className="size-1.5 bg-fd-primary" />
      <div className="h-px w-8 bg-fd-primary" />
      <div className="size-1.5 bg-fd-primary" />
      <div className="h-px w-4 bg-fd-border" />
      <div className="size-1 bg-fd-border" />
      <div className="h-px flex-1 bg-fd-border" />
    </div>
  );
}

function FAQItem({
  question,
  answer,
}: {
  question: string;
  answer: string;
}) {
  return (
    <details className="group border-b border-fd-border last:border-b-0">
      <summary className="flex cursor-pointer items-center justify-between py-4 text-left font-medium text-fd-foreground transition-colors hover:text-fd-primary">
        {question}
        <ChevronDown className="size-4 shrink-0 text-fd-muted-foreground transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <p className="pb-4 text-sm text-fd-muted-foreground">{answer}</p>
    </details>
  );
}

export default function HomePage() {
  return (
    <main className="flex flex-col">
      {/* Hero */}
      <section className="relative flex flex-col items-center justify-center gap-6 overflow-hidden px-4 py-24 text-center md:py-32">
        {/* PCB dot grid */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle, var(--color-fd-muted-foreground) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
            opacity: 0.15,
            maskImage:
              "radial-gradient(ellipse at center, black 30%, transparent 70%)",
            WebkitMaskImage:
              "radial-gradient(ellipse at center, black 30%, transparent 70%)",
          }}
        />
        <Trace className="pointer-events-none absolute left-0 right-0 top-8" />

        {/* Version badge */}
        <div className="relative inline-flex items-center gap-2 border border-fd-primary/30 bg-fd-primary/5 px-3 py-1 text-xs font-medium tracking-wide text-fd-primary">
          <span className="size-1.5 bg-fd-primary" />
          Where hardware meets design
        </div>

        <h1 className="relative max-w-3xl text-4xl font-bold tracking-tight text-fd-foreground sm:text-5xl md:text-6xl">
          Microcontrollers
          <br />
          <span style={{ color: "oklch(0.65 0.14 56)" }}>made simple.</span>
        </h1>
        <p className="relative max-w-xl text-fd-muted-foreground">
          A set of tools to make it easier to start prototyping for interactivity
        </p>
        <div className="relative flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="inline-flex items-center gap-2 border border-fd-primary bg-fd-primary px-6 py-2.5 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
          >
            Get started
            <ArrowRight className="size-3.5" />
          </Link>
          <a
            href="https://github.com/xiduzo/microflow"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border border-fd-border px-6 py-2.5 text-sm font-medium text-fd-foreground transition-colors hover:border-fd-primary/50 hover:bg-fd-primary/5"
          >
            <Github className="size-4" />
            GitHub
          </a>
        </div>

        <Trace className="pointer-events-none absolute bottom-8 left-0 right-0" />
      </section>

      {/* Features */}
      <section className="border-t border-fd-border bg-fd-card/50 px-4 py-20">
        <div className="mx-auto max-w-5xl">
          <div className="mb-2 text-center text-xs font-medium tracking-widest text-fd-primary uppercase">
            Capabilities
          </div>
          <h2 className="mb-4 text-center text-3xl font-bold text-fd-foreground">
            Rapid prototyping
          </h2>
          <p className="mx-auto mb-12 max-w-2xl text-center text-fd-muted-foreground">
            Don&apos;t worry about low-level coding, or coding at all for that matter. Focus on
            creating engaging interactions and bringing your ideas to life quickly.
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="group relative border border-fd-border bg-fd-background p-6 transition-colors hover:border-fd-primary/50 hover:bg-fd-primary/5"
              >
                {/* PCB corner decorators */}
                <div className="pointer-events-none absolute left-0 top-0 size-3 border-l border-t border-fd-primary/40" />
                <div className="pointer-events-none absolute right-0 top-0 size-3 border-r border-t border-fd-primary/40" />
                <div className="pointer-events-none absolute bottom-0 left-0 size-3 border-b border-l border-fd-primary/40" />
                <div className="pointer-events-none absolute bottom-0 right-0 size-3 border-b border-r border-fd-primary/40" />
                <feature.icon className="mb-4 size-6 text-fd-primary" />
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-fd-foreground">
                  {feature.title}
                </h3>
                <p className="text-sm leading-relaxed text-fd-muted-foreground">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Highlights */}
      <section className="px-4 py-20">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-8 md:grid-cols-3">
            {highlights.map((item) => (
              <div key={item.title} className="relative pl-5">
                {/* Left PCB trace accent */}
                <div className="absolute left-0 top-0 flex h-full flex-col items-center">
                  <div className="size-2 bg-fd-primary" />
                  <div className="w-px flex-1 bg-fd-primary/20" />
                </div>
                <item.icon className="mb-3 size-5 text-fd-primary" />
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-fd-foreground">
                  {item.title}
                </h3>
                <p className="text-sm leading-relaxed text-fd-muted-foreground">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-fd-border bg-fd-card/50 px-4 py-20">
        <div className="mx-auto max-w-2xl">
          <div className="mb-2 text-center text-xs font-medium tracking-widest text-fd-primary uppercase">
            Support
          </div>
          <h2 className="mb-4 text-center text-3xl font-bold text-fd-foreground">
            Frequently asked questions
          </h2>
          <p className="mb-10 text-center text-fd-muted-foreground">
            Some of the most common questions answered for you.
          </p>
          <div className="border border-fd-border bg-fd-background px-6">
            {faqs.map((faq) => (
              <FAQItem key={faq.question} question={faq.question} answer={faq.answer} />
            ))}
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <section className="px-4 py-20 text-center">
        <div className="mx-auto max-w-md">
          <Trace className="mx-auto mb-8" />
          <h2 className="mb-4 text-2xl font-bold text-fd-foreground">Ready to get started?</h2>
          <p className="mb-6 text-fd-muted-foreground">
            Check out the docs and start building with Microflow.
          </p>
          <Link
            href="/docs"
            className="inline-flex items-center gap-2 bg-fd-primary px-6 py-2.5 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
          >
            Read the docs
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-fd-border py-8 text-center text-xs text-fd-muted-foreground">
        <p>
          Made with ♥ by{" "}
          <a
            href="https://sanderboer.nl/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline transition-colors hover:text-fd-foreground"
          >
            Xiduzo
          </a>
        </p>
      </footer>
    </main>
  );
}
