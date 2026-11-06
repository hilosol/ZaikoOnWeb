/** 利用者にそのまま表示できるメッセージを持つエラー。HTTP ステータスに対応付ける。 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(errors: string | string[]) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(400, list.join("\n"), list);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "対象のデータが見つかりません。他の人が削除した可能性があります。") {
    super(404, message);
  }
}

/** 他の人が先に更新した（楽観的排他制御） */
export class ConflictError extends AppError {
  constructor(message = "他の人がこの商品を更新しました。画面を開き直してから再度操作してください。") {
    super(409, message);
  }
}

/** 外部のサーバー（メールサーバーなど）との通信に失敗した */
export class ExternalServiceError extends AppError {
  constructor(message: string) {
    super(502, message);
  }
}
