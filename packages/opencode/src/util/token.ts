import { Tiktoken } from "js-tiktoken/lite"
import cl100k_base from "js-tiktoken/ranks/cl100k_base"

export namespace Token {
  let enc: Tiktoken | undefined

  function encoder() {
    if (!enc) enc = new Tiktoken(cl100k_base)
    return enc
  }

  export function estimate(input: string) {
    if (!input) return 0
    return encoder().encode(input).length
  }
}
