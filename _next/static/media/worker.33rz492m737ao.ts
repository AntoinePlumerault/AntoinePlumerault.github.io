import { LanguageModel } from "./llm";
import Text2BytesCodec from "./text2bytes";
import Cypher from "./crypto";
import Bytes2TextCodec, { TokenError } from "./bytes2text";
import { AutoModelForCausalLM, AutoTokenizer } from "@huggingface/transformers";

import { User, Message } from "./data";

const eomToken = "\n";

function messagesToContext(messages: Message[], user: User) {
  const context =
    messages
      .map(
        (message) =>
          (message.user === User.Alice ? "- A: " : "- B: ") +
          message.content +
          eomToken,
      )
      .reduce((a, v) => a + v, "") + (user === User.Alice ? "- A:" : "- B:");
  return context;
}

interface Pipeline {
  languageModel: LanguageModel;
  text2BytesCodec: Text2BytesCodec;
  bytes2TextCodec: Bytes2TextCodec;
  cypher: Cypher;
}

class PipelineSingleton {
  static instance: Pipeline | null = null;
  static async getInstance() {
    if (this.instance === null) {
      self.postMessage({
        type: "info",
        payload: "LLM loading...",
      });
      const eomToken = "\n";
      const newBaseTokenizer =
        await AutoTokenizer.from_pretrained("Xenova/gpt2");

      const newBaseModel = await AutoModelForCausalLM.from_pretrained(
        "Xenova/gpt2",
        { dtype: "q4", device: "webgpu" },
      );

      const languageModel = new LanguageModel(newBaseModel, newBaseTokenizer);
      const text2BytesCodec = new Text2BytesCodec(languageModel, eomToken);
      const cypher = new Cypher();
      const bytes2TextCodec = new Bytes2TextCodec(languageModel, {
        temperature: 0.9,
        topP: 0.9,
        topK: 200,
        stopToken: eomToken,
      });

      this.instance = {
        languageModel,
        text2BytesCodec,
        bytes2TextCodec,
        cypher,
      };
    }
    return this.instance;
  }
}

async function encrypt(
  pipeline: Pipeline,
  key: CryptoKey,
  messages: Message[],
  newMessage: Message,
): Promise<Message> {
  // const key = await pipeline.cypher.getDeterministicKey(password, "salt");
  // console.log("encrypt key", key);

  const { user, content } = newMessage;
  console.log("encrypt content", user, "--", `|${content}|`);
  const nonceCount = messages.length;
  // Compress text to bytes
  const secretContext = messagesToContext(messages, user);
  console.log("encrypt context", nonceCount, secretContext);
  // console.log(secretContext);

  // We need to add a blank space to text
  const textBytes = await pipeline.text2BytesCodec.encode(
    " " + content, //+ "\n",
    secretContext,
  );

  // Encrypt bytes
  const encryptedTextBytes = await pipeline.cypher.encrypt(
    key,
    textBytes,
    nonceCount,
  );

  // Generate text to  transmit from bytes
  const context = messagesToContext(messages, user);
  const encryptedText = await pipeline.bytes2TextCodec.encode(
    encryptedTextBytes,
    context,
  );

  console.log("encryptedText", `|${encryptedText}|`);
  if (encryptedText[0] !== " ")
    console.error(
      `encryptedText does not start with space: |${encryptedText}|`,
    );

  return {
    ...newMessage,
    content: encryptedText.slice(1),
  };
}

async function decrypt(
  pipeline: Pipeline,
  key: CryptoKey,
  messages: Message[],
  newMessage: Message,
): Promise<Message> {
  // const key = await pipeline.cypher.getDeterministicKey(password, "salt");
  // console.log("decrypt key", key);
  const fingerprint = await pipeline.cypher.getFingerprint(key);

  const { user, content } = newMessage;
  console.log("decrypt content", user, "--", `|${content}|`);
  const nonceCount = messages.length;
  const context = messagesToContext(messages, user);
  console.log("decrypt context", nonceCount, context);
  try {
    const textBytes = await pipeline.bytes2TextCodec.decode(
      " " + content,
      context,
    );

    const decryptedTextBytes = await pipeline.cypher.decrypt(
      key,
      textBytes,
      nonceCount,
    );

    const decryptedText = await pipeline.text2BytesCodec.decode(
      decryptedTextBytes,
      context,
    );
    console.log(`full decrypted text |${decryptedText}|`);
    return {
      ...newMessage,
      decryptedContent: decryptedText.slice(1),
      fingerprint: fingerprint,
    };
  } catch (e) {
    if (e instanceof TokenError) {
      // If we get token error it means the message was not encoded with the provided password
      console.log("NOT ENCRYPTED");
      return {
        ...newMessage,
        decryptedContent: null,
        fingerprint: fingerprint,
      };
    } else {
      throw e;
    }
  }
}

self.addEventListener("message", async (event) => {
  const pipeline = await PipelineSingleton.getInstance();

  const { type, payload } = event.data;

  //   const { user, text, messages, password } = payload;

  switch (type) {
    case "encrypt": {
      const {
        password,
        messages,
        newMessage,
      }: { password: string; messages: Message[]; newMessage: Message } =
        payload;

      const key = await pipeline.cypher.getDeterministicKey(password, "salt");
      console.log("worker", messages, newMessage);
      // Encryption
      self.postMessage({
        type: "info",
        payload: "Encrypting message...",
      }); // Async function -> Give feedback
      const encryptedMessage = await encrypt(
        pipeline,
        key,
        messages,
        newMessage,
      );

      // Decryption (Always decrypt after encryption to test)
      self.postMessage({
        type: "info",
        payload: "Decrypting message...",
      }); // Async function -> Give feedback
      const decryptedMessage = await decrypt(
        pipeline,
        key,
        messages,
        encryptedMessage,
      );

      // Check
      if (newMessage.content !== decryptedMessage.decryptedContent) {
        self.postMessage({
          type: "error",
          payload: `original: |${newMessage.content}| decrypted: |${decryptedMessage.decryptedContent}|`,
        });
        self.postMessage({
          type: "encrypt",
          payload: { status: "failure", encryptedMessage, decryptedMessage },
        });
        return;
      }

      // returns
      self.postMessage({
        type: "encrypt",
        payload: { status: "success", encryptedMessage, decryptedMessage },
      });

      break;
    }
    case "decrypt": {
      self.postMessage({
        type: "info",
        payload: "Decrypting messages...",
      }); // Async function -> Give feedback
      const { password, messages }: { password: string; messages: Message[] } =
        payload;

      const key = await pipeline.cypher.getDeterministicKey(password, "salt");
      const fingerprint = await pipeline.cypher.getFingerprint(key);

      const decryptedMessages: Message[] = [];
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.fingerprint === fingerprint) {
          // Message was already decrypted
          decryptedMessages.push(message);
        } else {
          // We try a new passord or message was never decrypted
          const decryptedMessage = await decrypt(
            pipeline,
            key,
            decryptedMessages,
            message,
          );
          decryptedMessages.push(decryptedMessage);
        }
      }
      console.log("SENDING...");
      self.postMessage({
        type: "decrypt",
        payload: {
          status: "success",
          decryptedMessages,
        },
      });
      break;
    }
    // case "encryptAndSendMessage":
    //   self.postMessage({
    //     type: "log",
    //     payload: { message: "Encoding..." },
    //   });

    //   const encryptedText = await encode(pipeline, {
    //     user,
    //     text,
    //     messages,
    //     key,
    //   });

    //   self.postMessage({
    //     type: "log",
    //     payload: { message: "Checking..." },
    //   });

    //   const decryptedText_ = await decode(pipeline, {
    //     user,
    //     text: encryptedText_,
    //     messages,
    //     key,
    //   });

    //   if (decryptedText_ !== text) {
    //     self.postMessage({
    //     type: "encryptAndSendMessage",
    //     payload: { status: "failed", message: "Checking..." },
    //   });
    //   }

    //   break;

    // case "encode": {
    //   self.postMessage({
    //     type: "log",
    //     payload: { message: "Encoding..." },
    //   });
    //   const encryptedText = await encode(pipeline, {
    //     user,
    //     text,
    //     messages,
    //     key,
    //   });

    //   self.postMessage({
    //     type: "encodeComplete",
    //     output: { encryptedText },
    //   });
    //   break;
    // }

    // case "decode": {
    //   self.postMessage({
    //     type: "log",
    //     payload: { message: "Decoding..." },
    //   });
    //   const decryptedText = await decode(pipeline, {
    //     user,
    //     text,
    //     messages,
    //     key,
    //   });

    //   self.postMessage({
    //     type: "decodeComplete",
    //     payload: { decryptedText },
    //   });
    //   break;
    // }

    // case "encodeAndDecode": {
    //   self.postMessage({
    //     type: "log",
    //     payload: { message: "Encoding..." },
    //   });
    //   const encryptedText_ = await encode(pipeline, {
    //     user,
    //     text,
    //     messages,
    //     key,
    //   });
    //   self.postMessage({
    //     type: "log",
    //     payload: { message: "Decoding..." },
    //   });
    //   const decryptedText_ = await decode(pipeline, {
    //     user,
    //     text: encryptedText_,
    //     messages,
    //     key,
    //   });

    //   self.postMessage({
    //     type: "log",
    //     payload: { message: "" },
    //   });
    //   self.postMessage({
    //     type: "encodeAndDecodeComplete",
    //     payload: {
    //       user: user,
    //       text: text,
    //       encryptedText: encryptedText_,
    //       decryptedText: decryptedText_,
    //     },
    //   });
    //   break;
    // }
    default: {
      self.postMessage({
        type: "error",
        payload: {
          message: `Invalid event type: ${type}`,
        },
      });
    }
  }
});
