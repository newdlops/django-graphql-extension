from graphene import ObjectType, String, Int, Field, Schema


class UserType(ObjectType):
    id = Int()
    name = String()
    email = String()


class Query(ObjectType):
    user = Field(UserType, id=Int(required=True))


schema = Schema(query=Query)
