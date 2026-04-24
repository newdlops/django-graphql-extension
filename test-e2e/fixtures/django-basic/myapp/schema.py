from graphene import ObjectType, String, Int, Field, List, Boolean, Schema


class ExerciseHistoryType(ObjectType):
    date = String()
    quantity = Int()


class OptionGroupSummaryType(ObjectType):
    label = String()
    grant_quantity = Int()
    current_quantity = Int()
    exercised_quantity = Int()
    exercise_histories = List(ExerciseHistoryType)


class OptionStatsType(ObjectType):
    soft_limit_authorized_option_quantity = Int()
    granted_options_quantity = Int()
    exercised_options_quantity = Int()
    is_recover_grantable_options_after_exercise = Boolean()


class UserType(ObjectType):
    id = Int()
    name = String()
    email = String()


class Query(ObjectType):
    user = Field(UserType, id=Int(required=True))
    option_stats = Field(OptionStatsType, base_date=String())
    option_group_summaries = List(OptionGroupSummaryType, base_date=String())


schema = Schema(query=Query)
