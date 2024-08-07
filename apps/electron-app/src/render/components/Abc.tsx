import { renderAbc } from "abcjs";
import { useEffect, useRef } from "react";

export function MusicSheet(props: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const abcString = convertToABC(props.song)

    renderAbc(ref.current, abcString, {
      responsive: "resize",
      selectionColor: "white",
    })
  }, [props.song])

  return <div className="w-full" ref={ref} />
}

function convertToABC(notes: [string | null, number][]) {
    let abcString = "";
    const beatsPerBar = 4
    const barsPerLine = 4
    const beatsPerLine = beatsPerBar * barsPerLine

    let barBeatCount = 0;
    let lineBeatCount = 0;

    // https://www.youtube.com/watch?v=H8hWKP5cEXE
    notes.forEach(([fullNote, duration], index) => {
      const nodeDuration = getNodeDuration(duration)
      const beatDuration = duration * beatsPerBar
      barBeatCount += beatDuration
      lineBeatCount += beatDuration

      // abcString += `"${beatDuration}"`
      if (!fullNote) {
        abcString += `z${nodeDuration} `
      } else {
        let note = fullNote.at(0)
        const octave = Number(fullNote.at(-1))
        const sharp = fullNote.includes("#") ? "^" : ""

        if(octave > 4) {
          if(octave >= 5) {
            note = note.toLowerCase()
          }

          if(octave > 5) {
            const octavesUp = Array.from({ length: octave - 5 }).map(x => "'").join("")
            note = note + octavesUp
          }
        } else if (octave < 4) {
          const octavesDown = Array.from(({ length: 4 - octave })).map(x => ",").join("")
          note = note + octavesDown
        }

        abcString += `${sharp}${note}${nodeDuration} `
      }

      if(barBeatCount >= beatsPerBar) {
        abcString += "|"
        barBeatCount = 0
      }

      if(lineBeatCount >= beatsPerLine) {
        abcString += "\n "
        lineBeatCount = 0
        barBeatCount = 0
      }
    })

    Array.from({ length: beatsPerLine - lineBeatCount % beatsPerLine }).forEach(() => abcString += "x ") // Fill rest of the line

    abcString += "|]" // end of song

    return `
X:1
T: Piezo song
C: Microflow studio
M: ${beatsPerBar}/4
L: 1/8
K: C
${abcString}
`
}

function getNodeDuration(duration: number) {
  switch (duration) {
    case 2:
      return "16";
    case 1:
      return "8";
    case 1/2:
      return "4";
    case 1/4:
      return "2";
    case 1/8:
      return "1";
    case 1/16:
      return "/2";
    case 1/32:
      return "/4";
    default:
      return "";
  }
}

type Props = {
  song: [string | null, number][]
}
