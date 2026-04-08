import { get_encoding } from "@dqbd/tiktoken"

export namespace Token {
  let enc: ReturnType<typeof get_encoding> | undefined

  function encoder() {
    if (!enc) enc = get_encoding("cl100k_base")
    return enc
  }

  export function estimate(input: string) {
    if (!input) return 0
    return encoder().encode(input).length
  }
}
